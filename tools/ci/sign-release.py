#!/usr/bin/env python3
"""Sign the exact final manifest with the existing release authority.

The key is protected by a passphrase: it is passed through stdin, never through arguments or logs.
"""
import os,subprocess,tempfile
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('repos',Path(__file__).with_name('package-repositories.py'));m=module_from_spec(spec);spec.loader.exec_module(m)
if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Protected GitHub signing job required')
passphrase=os.environ.get('RELEASE_SIGNING_PASSPHRASE','')
if not passphrase:raise RuntimeError('RELEASE_SIGNING_PASSPHRASE is required')
with tempfile.TemporaryDirectory(prefix='silicium-release-sign-') as home:
    home=Path(home)/'gpg';key=m.import_key(home,'RELEASE_SIGNING')
    file=m.ROOT/'.artifacts/publish/manifest.json'
    subprocess.run(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-fd','0','--homedir',str(home),'--local-user',key,'--armor','--output',str(file)+'.asc','--detach-sign',str(file)],input=(passphrase+'\n').encode(),check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    m.command(['gpg','--homedir',str(home),'--verify',str(file)+'.asc',str(file)])
