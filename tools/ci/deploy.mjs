/** Request records and transfer immutable release assets through GitHub. */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, repository } from '../lib/github.mjs';
import { root, run, readJson, Failure } from '../lib/process.mjs';
import { sha256, verifyManifestAssetDirectory } from '../lib/manifest.mjs';
import { deploymentSsh } from '../lib/ssh.mjs';
const dir = resolve(root, '.artifacts/deploy');
mkdirSync(dir, { recursive: true });
const rid = process.env.RELEASE_ID,
  channel = process.env.RELEASE_CHANNEL;
if (
  !['dev', 'prod'].includes(channel) ||
  !new RegExp(`^${channel}-[0-9]+\\.[0-9]+\\.[0-9]+(?:-dev\\.[0-9]+)?-[a-f0-9]{12}$`).test(
    rid ?? '',
  )
)
  throw new Failure('Invalid deployment identity');
run(['gh', 'release', 'download', rid, '--repo', repository, '--dir', dir]);
run([
  'gpgv',
  '--keyring',
  resolve(root, 'contracts/trust/release.gpg'),
  resolve(dir, 'manifest.json.asc'),
  resolve(dir, 'manifest.json'),
]);
const m = verifyManifestAssetDirectory(readJson(resolve(dir, 'manifest.json')), dir);
if (m.release_id !== rid || m.channel !== channel) throw new Failure('Release/channel mismatch');
if (m.qualification.repository !== 'Silicium-Project/Integration')
  throw new Failure('Candidate is not bound to private Integration qualification');
const sourceCompare = api(`repos/${repository}/compare/${m.source_sha}...main`);
if (!['ahead', 'identical'].includes(sourceCompare.status))
  throw new Failure('Candidate Workbench source is not included in Workbench main');
const digest = sha256(readFileSync(resolve(dir, 'manifest.json')));
const env = channel === 'dev' ? 'development' : 'production';
const deployment = api(`repos/${repository}/deployments`, {
  method: 'POST',
  body: {
    ref: m.source_sha,
    environment: env,
    auto_merge: false,
    required_contexts: [],
    transient_environment: channel === 'dev',
    production_environment: channel === 'prod',
    payload: { run_id: process.env.GITHUB_RUN_ID, release_id: rid, manifest_digest: digest },
  },
});
const status = (state) =>
  api(`repos/${repository}/deployments/${deployment.id}/statuses`, {
    method: 'POST',
    body: {
      state,
      log_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      auto_inactive: state === 'success',
    },
  });
status('in_progress');
try {
  const session = deploymentSsh();
  try {
    const ssh = session.args,
      dest = session.destination,
      remote = `/var/lib/silicium-delivery/incoming/${rid}`;
    run(['ssh', ...ssh, dest, `mkdir -p ${remote}`]);
    run(
      [
        'scp',
        ...ssh,
        resolve(dir, 'manifest.json'),
        resolve(dir, 'manifest.json.asc'),
        ...m.assets.map((a) => resolve(dir, a.name)),
        `${dest}:${remote}/`,
      ],
      { timeout: 600_000 },
    );
    // This root-owned entry point is installed separately; do not execute uploaded scripts as root.
    const result = run(
      [
        'ssh',
        ...ssh,
        dest,
        `sudo -n /usr/local/sbin/silicium-apply --candidate ${remote} --channel ${channel} --keep-update-feed`,
      ],
      { timeout: 600_000 },
    );
    const applied = JSON.parse(result.stdout);
    if (applied.release_id !== rid || applied.manifest_digest !== digest)
      throw new Failure('Host did not confirm the expected candidate');
    status('success');
    console.log(
      JSON.stringify({
        schema_version: 1,
        status: 'success',
        release_id: rid,
        manifest_digest: digest,
        deployment_id: deployment.id,
      }),
    );
  } finally {
    session.close();
  }
} catch (e) {
  status('failure');
  throw e;
}
