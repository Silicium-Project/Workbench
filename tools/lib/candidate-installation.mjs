import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Failure, writeJson } from './process.mjs';

/** Persist the signed prior release fields consumed by package upgrade tests. */
export function writePreviousInstallBaseline(candidateDir, previous) {
  const output = resolve(candidateDir, 'previous.json');
  // A services-only previous release (contract v1 dev) ships no packages, so it has no upgrade baseline.
  if (previous == null || previous.packages === 'not_included') {
    rmSync(output, { force: true });
    return null;
  }
  const packageAsset = previous.assets?.find((asset) => asset.name === 'packages.tar.gz');
  if (
    typeof previous.release_id !== 'string' ||
    !previous.components?.node?.version ||
    !packageAsset ||
    !/^[a-f0-9]{64}$/.test(packageAsset.sha256 ?? '')
  )
    throw new Failure('Previous signed release lacks the package upgrade baseline');

  const baseline = {
    release_id: previous.release_id,
    components: previous.components,
    assets: previous.assets,
  };
  writeJson(output, baseline);
  return baseline;
}
