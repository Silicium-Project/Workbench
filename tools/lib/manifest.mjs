/** Delivery identities are immutable; a digest is never a mutable image tag. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Failure } from './process.mjs';
const privateSources = Object.freeze({
  api: 'Silicium-Project/BackEnd',
  web: 'Silicium-Project/FrontEnd',
  node: 'Silicium-Project/DesktopApp',
  network: 'Silicium-Project/Network',
  solana: 'Silicium-Project/Solana',
});
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function validateManifest(m) {
  if (!isRecord(m)) return ['manifest must be a JSON object'];

  const errors = [];
  const sourceSha = typeof m.source_sha === 'string' ? m.source_sha : '';
  const version = typeof m.version === 'string' ? m.version : '';
  if (m.schema_version !== 1) errors.push('unsupported manifest version');
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) errors.push('invalid source SHA');
  if (!['dev', 'prod'].includes(m.channel)) errors.push('invalid channel');
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(version)) errors.push('invalid release version');
  if (m.channel === 'prod' && version.includes('-'))
    errors.push('production cannot use a prerelease');
  if (m.channel === 'dev' && !version.includes('-dev.'))
    errors.push('development must use a prerelease');
  // Contract v1: a dev candidate may ship services only, with an explicit packages field.
  const packagesMode = m.packages ?? 'included';
  if (!['included', 'not_included'].includes(packagesMode)) errors.push('invalid packages mode');
  if (packagesMode === 'not_included' && m.channel !== 'dev')
    errors.push('packages may be excluded only from the dev channel');
  // Contract v1b: the network service may stay on its running image, only in dev.
  const networkMode = m.network ?? 'included';
  if (!['included', 'unchanged'].includes(networkMode)) errors.push('invalid network mode');
  if (networkMode === 'unchanged' && m.channel !== 'dev')
    errors.push('network may stay unchanged only in the dev channel');
  if (m.release_id !== `${m.channel}-${version}-${sourceSha.slice(0, 12)}`)
    errors.push('candidate identity mismatch');
  const qualification = isRecord(m.qualification) ? m.qualification : null;
  const componentPins = isRecord(qualification?.component_pins)
    ? qualification.component_pins
    : null;
  if (
    !qualification ||
    qualification.source_sha !== sourceSha ||
    qualification.status !== 'success' ||
    qualification.repository !== 'Silicium-Project/Integration' ||
    qualification.workflow !== '.github/workflows/qualification.yml' ||
    qualification.workbench_sha !== sourceSha ||
    !/^[1-9][0-9]*$/.test(String(qualification.run_id)) ||
    !Number.isSafeInteger(Number(qualification.run_attempt)) ||
    Number(qualification.run_attempt) < 1 ||
    !Number.isSafeInteger(Number(qualification.run_number)) ||
    Number(qualification.run_number) < 1 ||
    !/^[a-f0-9]{40}$/.test(qualification.integration_sha ?? '') ||
    !/^[a-f0-9]{40}$/.test(qualification.policy_workflow_sha ?? '') ||
    !/^[a-f0-9]{64}$/.test(qualification.policy_digest ?? '') ||
    m.policy_digest !== qualification.policy_digest ||
    !componentPins ||
    Object.keys(componentPins).sort().join() !== 'api,network,node,solana,web' ||
    Object.entries(privateSources).some(([component, repository]) => {
      const pin = componentPins[component];
      if (!isRecord(pin)) return true;
      return pin?.repository !== repository || !/^[a-f0-9]{40}$/.test(pin.commit ?? '');
    })
  )
    errors.push('private Integration qualification missing or stale');
  if (!isRecord(m.components)) errors.push('components must be a JSON object');
  else {
    const requiredComponents = [
      'api',
      'web',
      ...(networkMode === 'included' ? ['network'] : []),
      ...(packagesMode === 'included' ? ['node'] : []),
    ];
    for (const component of requiredComponents)
      if (!m.components[component]) errors.push(`missing component ${component}`);
    if (networkMode === 'unchanged' && m.components.network)
      errors.push('network component present but network is unchanged');
    for (const [name, c] of Object.entries(m.components)) {
      if (!['web', 'api', 'network', 'node', 'solana', 'sdk'].includes(name))
        errors.push('unknown component');
      if (!isRecord(c)) {
        errors.push(`${name}: component metadata must be a JSON object`);
        continue;
      }
      if (!/^[a-f0-9]{40}$/.test(c.source_sha ?? ''))
        errors.push(`${name}: missing component provenance`);
      if (
        c.image !== undefined &&
        c.image !== null &&
        (typeof c.image !== 'string' ||
          !/^ghcr\.io\/silicium-project\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(c.image))
      )
        errors.push(`${name}: image must use an allowed immutable digest`);
    }
  }
  const names = new Set();
  if (!Array.isArray(m.assets)) errors.push('assets must be a JSON array');
  else {
    for (const asset of m.assets) {
      if (!isRecord(asset)) {
        errors.push('invalid asset identity');
        continue;
      }
      const name = typeof asset.name === 'string' ? asset.name : '';
      if (names.has(name)) errors.push('duplicate asset');
      names.add(name);
      if (name === 'manifest.json' || name === 'manifest.json.asc')
        errors.push('reserved candidate asset name');
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1
      )
        errors.push('invalid asset identity');
    }
  }
  const requiredAssets =
    packagesMode === 'included'
      ? ['packages.tar.gz', 'deployment.tar.gz', 'qualification.json']
      : ['deployment.tar.gz', 'qualification.json'];
  if (packagesMode === 'not_included' && names.has('packages.tar.gz'))
    errors.push('packages excluded but packages.tar.gz present');
  if (!requiredAssets.every((name) => names.has(name))) errors.push('incomplete candidate assets');
  return errors;
}
export function requireManifest(m) {
  const errors = validateManifest(m);
  if (errors.length) throw new Failure(errors.join('\n'), 2);
  return m;
}
/** Verify the exact files that will be published or deployed against a signed manifest. */
export function verifyManifestAssetDirectory(m, directory) {
  const manifest = requireManifest(m);
  if (!lstatSync(directory).isDirectory())
    throw new Failure('Candidate asset path must be a real directory', 2);

  const expectedNames = [
    ...manifest.assets.map((asset) => asset.name),
    'manifest.json',
    'manifest.json.asc',
  ].sort();
  const actualNames = readdirSync(directory).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  )
    throw new Failure('Candidate asset directory does not match the manifest asset set', 2);

  for (const name of ['manifest.json', 'manifest.json.asc']) {
    const info = lstatSync(resolve(directory, name));
    if (!info.isFile() || info.size < 1)
      throw new Failure(`${name}: candidate signature input must be a non-empty regular file`, 2);
  }
  for (const asset of manifest.assets) {
    const path = resolve(directory, asset.name);
    const info = lstatSync(path);
    if (!info.isFile())
      throw new Failure(`${asset.name}: candidate asset is not a regular file`, 2);
    const bytes = readFileSync(path);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256)
      throw new Failure(`${asset.name}: candidate asset integrity failure`, 2);
  }
  return manifest;
}
export function packageVersions(version) {
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(version)) throw new Failure('Invalid version', 2);
  const [base, pre] = version.split('-');
  const sequence = pre ? Number(pre.split('.')[1]) : 65535;
  if (base.split('.').some((n) => Number(n) > 65535))
    throw new Failure('Windows version fields must fit 0..65535', 2);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > (pre ? 65534 : 65535))
    throw new Failure('Windows dev sequence must fit 1..65534; 65535 is reserved for stable', 2);
  return {
    semver: version,
    deb: pre ? `${base}~${pre}` : base,
    rpm: pre ? `${base}~${pre}` : base,
    rpm_release: '1',
    windows: `${base}.${sequence}`,
  };
}
export function compareVersions(a, b) {
  packageVersions(a);
  packageVersions(b);
  const parts = (value) => {
    const [base, pre] = value.split('-');
    return [...base.split('.').map(Number), pre ? Number(pre.split('.')[1]) : 65535];
  };
  const left = parts(a),
    right = parts(b);
  for (let index = 0; index < left.length; index++)
    if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  return 0;
}
