/** Ephemeral SSH material, pinned hosts, fixed deployment identity. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Failure } from './process.mjs';
export function deploymentSsh() {
  const host = process.env.DEPLOY_SSH_HOST;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host ?? '') ||
    process.env.DEPLOY_SSH_USER !== 'silicium-deploy'
  )
    throw new Failure('Configure the restricted deployment identity');
  if (!process.env.DEPLOY_SSH_KEY || !process.env.DEPLOY_SSH_KNOWN_HOSTS)
    throw new Failure('Missing protected SSH configuration');
  const dir = mkdtempSync(join(tmpdir(), 'silicium-ssh-'));
  const key = join(dir, 'key'),
    known = join(dir, 'known_hosts');
  // Secret storage can drop the final newline; OpenSSH rejects a private key without it.
  const withNewline = (value) => (value.endsWith('\n') ? value : `${value}\n`);
  writeFileSync(key, withNewline(process.env.DEPLOY_SSH_KEY), { mode: 0o600 });
  writeFileSync(known, withNewline(process.env.DEPLOY_SSH_KNOWN_HOSTS), { mode: 0o600 });
  return {
    destination: `silicium-deploy@${host}`,
    args: [
      '-i',
      key,
      '-o',
      `UserKnownHostsFile=${known}`,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
    ],
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
