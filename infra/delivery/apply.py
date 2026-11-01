#!/usr/bin/env python3
"""Verify and apply prebuilt candidates. No git, build, test or secret generation on the VPS."""
import argparse, contextlib, fcntl, hashlib, json, os, re, shutil, stat, subprocess, tarfile, tempfile, time, urllib.request
from pathlib import Path

CHANNELS={'dev':('/var/lib/silicium-dev','/etc/silicium-dev','silicium-dev',8180,3300),
          'prod':('/var/lib/silicium','/etc/silicium','silicium',8080,3000)}

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
    return h.hexdigest()

def execute(args,**kwargs):
    p=subprocess.run(args,capture_output=True,text=True,**kwargs)
    if p.returncode:raise RuntimeError(f'Operation failed: {args[0]} (exit {p.returncode}); inspect private host diagnostics')
    return p.stdout

def required_assets(m):
    # Contract v1: only the dev channel may ship services without client packages.
    mode=m.get('packages','included')
    if mode not in ('included','not_included'):raise ValueError('Invalid packages mode')
    if mode=='not_included':
        if m.get('channel')!='dev':raise ValueError('Packages may be excluded only from the dev channel')
        return {'deployment.tar.gz','qualification.json'}
    return {'packages.tar.gz','deployment.tar.gz','qualification.json'}

def required_components(m):
    # Contract v1b: the network service may keep its running image, only on the dev channel.
    mode=m.get('network','included')
    if mode not in ('included','unchanged'):raise ValueError('Invalid network mode')
    if mode=='unchanged' and m.get('channel')!='dev':raise ValueError('Network may stay unchanged only in the dev channel')
    return {'api','web','network'} if mode=='included' else {'api','web'}

def verify_manifest(folder,channel,keyring):
    execute(['gpgv','--keyring',str(keyring),str(folder/'manifest.json.asc'),str(folder/'manifest.json')])
    raw=(folder/'manifest.json').read_bytes();m=json.loads(raw)
    if m.get('schema_version')!=1 or m.get('channel')!=channel:raise ValueError('Manifest/channel mismatch')
    if not re.fullmatch(r'[a-f0-9]{40}',m.get('source_sha','')):raise ValueError('Invalid source identity')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-dev\.\d+)?',m.get('version','')):raise ValueError('Invalid version')
    if m.get('release_id')!=f'{channel}-{m["version"]}-{m["source_sha"][:12]}':raise ValueError('Invalid candidate identity')
    if (channel=='dev')!=('-dev.' in m['version']):raise ValueError('Version/channel mismatch')
    if m.get('network','included')=='unchanged' and 'network' in m.get('components',{}):raise ValueError('Network component present but unchanged')
    for name in sorted(required_components(m)):
        c=m.get('components',{}).get(name,{})
        if not re.fullmatch(r'ghcr\.io/silicium-project/[a-z0-9._/-]+@sha256:[a-f0-9]{64}',c.get('image','')):raise ValueError('Missing immutable image')
    names=set()
    for a in m.get('assets',[]):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',a['name']) or a['name'] in names:raise ValueError('Invalid/duplicate asset name')
        names.add(a['name']);p=folder/a['name']
        if p.is_symlink() or p.stat().st_size!=a['size'] or digest(p)!=a['sha256']:raise ValueError('Artifact integrity failure')
    if m.get('packages','included')=='not_included' and 'packages.tar.gz' in names:raise ValueError('Packages excluded but packages.tar.gz present')
    if not required_assets(m)<=names:raise ValueError('Incomplete delivery')
    return m,hashlib.sha256(raw).hexdigest()

def extract(archive,target):
    target.mkdir(parents=True,exist_ok=True)
    with tarfile.open(archive,'r:gz') as t:
        for item in t.getmembers():
            p=Path(item.name)
            if p.is_absolute() or '..' in p.parts or not (item.isfile() or item.isdir()):raise ValueError('Unsafe archive member')
        # Avoid archive permissions/owners and keep Python 3.11 compatibility.
        for item in t.getmembers():
            destination=target/item.name
            if item.isdir():destination.mkdir(parents=True,exist_ok=True)
            else:
                destination.parent.mkdir(parents=True,exist_ok=True)
                with t.extractfile(item) as source,destination.open('xb') as output:shutil.copyfileobj(source,output)
                os.chmod(destination,0o644)

def copy_regular(source,destination):
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as incoming,destination.open('xb') as output:
        if not stat.S_ISREG(os.fstat(incoming.fileno()).st_mode):raise ValueError('Input must be a regular file')
        shutil.copyfileobj(incoming,output)

@contextlib.contextmanager
def immutable_input(folder,state,keyring):
    # The unprivileged SSH account can mutate incoming files. Verify a root-owned copy.
    with tempfile.TemporaryDirectory(prefix='verify-',dir=state) as temp:
        private=Path(temp)
        for name in ['manifest.json','manifest.json.asc']:copy_regular(folder/name,private/name)
        execute(['gpgv','--keyring',str(keyring),str(private/'manifest.json.asc'),str(private/'manifest.json')])
        manifest=json.loads((private/'manifest.json').read_text())
        for asset in manifest.get('assets',[]):
            name=asset['name']
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',name):raise ValueError('Unsafe input name')
            copy_regular(folder/name,private/name)
        yield private

def atomic_json(path,value):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(value,indent=2));os.chmod(tmp,0o600);tmp.replace(path)

def switch_link(link,target):
    if link.exists() and not link.is_symlink():raise RuntimeError(f'Existing directory {link} requires the documented one-time adoption; it will not be deleted')
    temp=link.with_name(link.name+'.next');temp.unlink(missing_ok=True);temp.symlink_to(target);temp.replace(link)

def health(manifest,manifest_digest,ports):
    paths=['/version','/__release']
    for port,path in zip(ports,paths):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=5) as response:
            data=json.load(response)
        # The API exposes release metadata nested under release; the web exposes it directly.
        release=data.get('release',data)
        if release.get('release_id')!=manifest['release_id'] or release.get('manifest_digest')!=manifest_digest:raise RuntimeError('Health/version identity mismatch')

def vpn_has_address(payload,address='10.77.0.1'):
    return any(row.get('local')==address for iface in payload for row in iface.get('addr_info',[]))

def compose_env(config):
    # The compose files read env_file from SILICIUM_CONFIG_DIR; a dev run must never read the prod config.
    return {**os.environ,'SILICIUM_CONFIG_DIR':str(config)}

def feed_guard(timer_active,keep_update_feed):
    # Desktop clients read the update feed written by the host timers. Retiring them needs a migration.
    if timer_active and not keep_update_feed:raise RuntimeError('Retire the legacy host manifest-publisher timer during adoption before deploying GitHub-signed snapshots, or deploy with --keep-update-feed during the transition')
    return 'keep' if keep_update_feed else 'switch'

def apply_verified(folder,channel,keep_update_feed=False):
    data,config,project,api_port,web_port=CHANNELS[channel];data=Path(data);config=Path(config)
    state=data/'delivery';state.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (state/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        m,md=verify_manifest(folder,channel,config/'release-trust.gpg')
        if channel=='dev' and not vpn_has_address(json.loads(execute(['ip','-j','-4','address','show']))):raise RuntimeError('The dev VPN address must exist before deployment')
        previous=json.loads((state/'current.json').read_text()) if (state/'current.json').exists() else None
        if previous and previous['release_id']==m['release_id']:
            if previous['manifest_digest']!=md:raise RuntimeError('Published identity was reused with different content')
            health(m,md,(api_port,web_port));return previous
        if not previous:raise RuntimeError('No rollback baseline. Adopt the existing deployment before the first automatic delivery')
        # A host publisher would mutate the signed snapshot after activation.
        timer='silicium-update-manifest'+('-dev' if channel=='dev' else '')+'.timer'
        active=subprocess.run(['systemctl','is-active','--quiet',timer],capture_output=True).returncode==0
        mode=feed_guard(active,keep_update_feed)
        if shutil.disk_usage(data).free < sum(a['size']for a in m['assets'])*3+1024**3:raise RuntimeError('Insufficient staging space')
        target=state/'candidates'/m['release_id']
        if target.exists():raise RuntimeError('Staged candidate already exists; inspect the previous attempt before retrying')
        target.mkdir(parents=True)
        extract(folder/'deployment.tar.gz',target)
        extract(folder/'packages.tar.gz',target)
        snapshots=data/'package-snapshots';snapshots.mkdir(mode=0o755,exist_ok=True)
        public_snapshot=snapshots/m['release_id']
        if public_snapshot.exists():raise RuntimeError('Immutable package snapshot already exists')
        shutil.copytree(target/'downloads',public_snapshot)
        for path in public_snapshot.rglob('*'):os.chmod(path,0o755 if path.is_dir() else 0o644)
        os.chmod(public_snapshot,0o755)
        for name in ['manifest.json','manifest.json.asc']:shutil.copy2(folder/name,target/name)
        env=target/'candidate.env'
        env.write_text('\n'.join([f'SILICIUM_{c.upper()}_IMAGE={(m["components"][c]["image"] if c in m["components"] else previous["network_image"])}'for c in ['api','web','network']]+[
            f'SILICIUM_RELEASE_CHANNEL={channel}',f'SILICIUM_RELEASE_ID={m["release_id"]}',f'SILICIUM_MANIFEST_DIGEST={md}',f'SILICIUM_RELEASE_VERSION={m["version"]}',f'SILICIUM_RELEASE_BUILD={m["source_sha"]}'])+'\n');os.chmod(env,0o600)
        def compose(candidate,*args):
            return execute(['docker','compose','--project-name',project,'--env-file',str(config/'compose.env'),'--env-file',str(candidate/'candidate.env'),'-f',str(candidate/'infra/compose/docker-compose.yml'),*args],env=compose_env(config))
        compose(target,'config','--quiet');compose(target,'pull','backend','frontend','reputation_bridge')
        network_image=m['components']['network']['image'] if 'network' in m['components'] else previous['network_image']
        network_changed=previous.get('network_image')!=network_image
        # A new runtime requires an atomic drain protocol. Missing telemetry never means idle.
        if network_changed:
            raise RuntimeError('Runtime update requires the qualified drain/rolling-update procedure; automatic forced restarts are prohibited')
        old=Path(previous['directory']);activated=False
        try:
            compose(target,'up','-d','--no-build','--no-deps','backend','frontend')
            for attempt in range(12):
                try:health(m,md,(api_port,web_port));break
                except Exception:
                    if attempt==11:raise
                    time.sleep(5)
            if mode=='switch':switch_link(data/'downloads',public_snapshot)
            activated=True
            value={'release_id':m['release_id'],'manifest_digest':md,'directory':str(target),'downloads':str(public_snapshot),'network_image':network_image,'previous':previous}
            atomic_json(state/'current.json',value)
            return {k:v for k,v in value.items() if k!='previous'}
        except Exception:
            compose(old,'up','-d','--no-build','--no-deps','backend','frontend')
            if activated and mode=='switch':switch_link(data/'downloads',Path(previous['downloads']))
            raise

def apply(folder,channel,keep_update_feed=False):
    data,config,*_=CHANNELS[channel];state=Path(data)/'delivery';state.mkdir(mode=0o700,parents=True,exist_ok=True)
    if not folder.is_relative_to('/var/lib/silicium-delivery/incoming'):raise ValueError('Candidate must come from the restricted incoming directory')
    with immutable_input(folder,state,Path(config)/'release-trust.gpg') as private:
        return apply_verified(private,channel,keep_update_feed)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--candidate',type=Path,required=True);p.add_argument('--channel',choices=CHANNELS,required=True);p.add_argument('--keep-update-feed',action='store_true');args=p.parse_args()
    if os.geteuid()!=0:p.error('Use the restricted deployment account/sudo command')
    print(json.dumps(apply(args.candidate.resolve(),args.channel,args.keep_update_feed)))
