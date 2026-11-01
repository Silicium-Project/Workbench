import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest,
  packageVersions,
  compareVersions,
  sha256,
  verifyManifestAssetDirectory,
} from '../../tools/lib/manifest.mjs';
import { trustedReleaseBaseline } from '../../tools/lib/release-baseline.mjs';
const sha = 'a'.repeat(40);
const candidate = () => ({
  schema_version: 1,
  source_sha: sha,
  channel: 'dev',
  version: '0.3.0-dev.1',
  release_id: `dev-0.3.0-dev.1-${sha.slice(0, 12)}`,
  qualification: {
    repository: 'Silicium-Project/Integration',
    workflow: '.github/workflows/qualification.yml',
    source_sha: sha,
    workbench_sha: sha,
    status: 'success',
    run_id: 123,
    run_attempt: 1,
    run_number: 31,
    integration_sha: 'b'.repeat(40),
    policy_workflow_sha: 'c'.repeat(40),
    policy_digest: 'd'.repeat(64),
    component_pins: Object.fromEntries(
      Object.entries({
        api: 'Silicium-Project/BackEnd',
        web: 'Silicium-Project/FrontEnd',
        node: 'Silicium-Project/DesktopApp',
        network: 'Silicium-Project/Network',
        solana: 'Silicium-Project/Solana',
      }).map(([name, repository]) => [name, { repository, commit: 'e'.repeat(40) }]),
    ),
  },
  policy_digest: 'd'.repeat(64),
  components: {
    ...Object.fromEntries(
      ['api', 'web', 'network'].map((name) => [
        name,
        { source_sha: sha, image: `ghcr.io/silicium-project/${name}@sha256:${'b'.repeat(64)}` },
      ]),
    ),
    node: { source_sha: sha, version: '0.3.0-dev.1', channel: 'dev' },
  },
  assets: ['packages.tar.gz', 'deployment.tar.gz', 'qualification.json'].map((name) => ({
    name,
    sha256: 'c'.repeat(64),
    size: 12,
  })),
});
test('release ordering reserves the final Windows field for stable and compares counters numerically', () => {
  assert.equal(compareVersions('0.3.0-dev.10', '0.3.0-dev.2'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0-dev.65534'), 1);
  assert.equal(compareVersions('0.4.0-dev.1', '0.3.0'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.throws(() => packageVersions('0.3.0-dev.65535'));
});
test('complete immutable identity validates', () =>
  assert.deepEqual(validateManifest(candidate()), []));
test('malformed JSON containers fail closed without throwing', () => {
  for (const value of [null, [], 'manifest']) assert.ok(validateManifest(value).length);

  const badQualification = candidate();
  badQualification.qualification = [];
  assert.ok(validateManifest(badQualification).length);

  const badPins = candidate();
  badPins.qualification.component_pins.api = null;
  assert.ok(validateManifest(badPins).length);

  const badComponents = candidate();
  badComponents.components.api = null;
  assert.ok(validateManifest(badComponents).length);

  const badAssets = candidate();
  badAssets.assets[0] = null;
  assert.ok(validateManifest(badAssets).length);
  assert.ok(validateManifest({ ...candidate(), assets: {} }).length);
});
test('mutable images, stale qualification and prod prereleases fail', () => {
  for (const edit of [
    (m) => (m.components.api.image = 'api:latest'),
    (m) => (m.qualification.source_sha = 'b'.repeat(40)),
    (m) => (m.channel = 'prod'),
  ]) {
    const m = candidate();
    edit(m);
    assert.ok(validateManifest(m).length);
  }
});
test('component pins and duplicated policy digest must remain exact', () => {
  const wrongPin = candidate();
  wrongPin.qualification.component_pins.node.repository = 'Silicium-Project/Network';
  assert.ok(validateManifest(wrongPin).length);
  const wrongPolicy = candidate();
  wrongPolicy.policy_digest = 'f'.repeat(64);
  assert.ok(validateManifest(wrongPolicy).length);
});
test('asset names cannot escape the snapshot', () => {
  const m = candidate();
  m.assets = [{ name: '../wallet', sha256: 'a'.repeat(64), size: 1 }];
  assert.ok(validateManifest(m).length);
});
test('reserved signature files cannot be listed as ordinary release assets', () => {
  const m = candidate();
  m.assets[0].name = 'manifest.json';
  assert.ok(validateManifest(m).includes('reserved candidate asset name'));
});
test('publication and deployment require the exact manifest asset set and bytes', () => {
  const createFixture = () => {
    const directory = mkdtempSync(join(tmpdir(), 'silicium-release-assets-'));
    const manifest = candidate();
    const payloads = new Map([
      ['packages.tar.gz', Buffer.from('packages')],
      ['deployment.tar.gz', Buffer.from('deployment')],
      ['qualification.json', Buffer.from('{}')],
    ]);
    manifest.assets = [...payloads].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: sha256(bytes),
    }));
    for (const [name, bytes] of payloads) writeFileSync(join(directory, name), bytes);
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'manifest.json.asc'), 'signature');
    return { directory, manifest };
  };

  const valid = createFixture();
  try {
    assert.equal(verifyManifestAssetDirectory(valid.manifest, valid.directory), valid.manifest);
    writeFileSync(join(valid.directory, 'unexpected.txt'), 'extra');
    assert.throws(
      () => verifyManifestAssetDirectory(valid.manifest, valid.directory),
      /does not match the manifest asset set/,
    );
  } finally {
    rmSync(valid.directory, { recursive: true, force: true });
  }

  const corrupt = createFixture();
  try {
    writeFileSync(join(corrupt.directory, 'packages.tar.gz'), 'tampered');
    assert.throws(
      () => verifyManifestAssetDirectory(corrupt.manifest, corrupt.directory),
      /candidate asset integrity failure/,
    );
  } finally {
    rmSync(corrupt.directory, { recursive: true, force: true });
  }

  const nonRegular = createFixture();
  try {
    rmSync(join(nonRegular.directory, 'packages.tar.gz'));
    mkdirSync(join(nonRegular.directory, 'packages.tar.gz'));
    assert.throws(
      () => verifyManifestAssetDirectory(nonRegular.manifest, nonRegular.directory),
      /candidate asset is not a regular file/,
    );
  } finally {
    rmSync(nonRegular.directory, { recursive: true, force: true });
  }
});
test('versions retain prerelease ordering and unique Windows sequence', () => {
  assert.deepEqual(packageVersions('0.3.0-dev.12'), {
    semver: '0.3.0-dev.12',
    deb: '0.3.0~dev.12',
    rpm: '0.3.0~dev.12',
    rpm_release: '1',
    windows: '0.3.0.12',
  });
  assert.equal(packageVersions('0.3.0').windows, '0.3.0.65535');
  for (const v of ['0.3.0+hidden', '0.3.0-dev.0', '0.3.0-dev.65535', '0.3.0-dev.65536', '$(id)'])
    assert.throws(() => packageVersions(v));
});

function release(tag, { channel = 'dev', signed = false, draft = false } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease: channel === 'dev',
    assets: signed
      ? [{ name: 'manifest.json' }, { name: 'manifest.json.asc' }]
      : [
          {
            name: 'release-channel.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
        ],
  };
}

test('release baseline selection allows an empty channel but requires the newest existing release to be signed', () => {
  assert.deepEqual(trustedReleaseBaseline([], 'dev'), {
    highestPublished: null,
    previous: null,
  });
  const current = release('dev-0.3.0-dev.31-aaaaaaaaaaaa', { signed: true });
  assert.equal(
    trustedReleaseBaseline([release('v0.2.9-dev.28'), current], 'dev').previous,
    current,
  );
  assert.throws(
    () => trustedReleaseBaseline([release('v0.2.9-dev.28')], 'dev'),
    /newest published dev release has no signed manifest/,
  );
  assert.throws(
    () =>
      trustedReleaseBaseline(
        [
          release('dev-0.3.0-dev.31-aaaaaaaaaaaa', { signed: true }),
          release('dev-0.3.0-dev.32-bbbbbbbbbbbb'),
        ],
        'dev',
      ),
    /newest published dev release has no signed manifest/,
  );
});

test('release baseline rejects duplicate or unsupported versions and keeps channels separate', () => {
  assert.deepEqual(trustedReleaseBaseline([release('v0.2.17', { channel: 'prod' })], 'dev'), {
    highestPublished: null,
    previous: null,
  });
  assert.throws(
    () =>
      trustedReleaseBaseline(
        [
          release('dev-0.3.0-dev.31-aaaaaaaaaaaa', { signed: true }),
          release('dev-0.3.0-dev.31-bbbbbbbbbbbb', { signed: true }),
        ],
        'dev',
      ),
    /duplicate versions/,
  );
  assert.throws(
    () => trustedReleaseBaseline([release('dev-latest')], 'dev'),
    /unsupported version tag/,
  );
  assert.throws(
    () =>
      trustedReleaseBaseline([{ tag_name: 'dev-0.3.0-dev.31-aaaaaaaaaaaa', draft: false }], 'dev'),
    /inventory is incomplete/,
  );
});

test('release baseline rejects channel tags that contradict GitHub prerelease metadata', () => {
  assert.throws(
    () =>
      trustedReleaseBaseline(
        [release('dev-0.3.0-dev.31-aaaaaaaaaaaa', { channel: 'prod' })],
        'dev',
      ),
    /dev release tag contradicts its prerelease metadata/,
  );
  assert.throws(
    () => trustedReleaseBaseline([release('v0.3.0')], 'prod'),
    /prod release tag contradicts its prerelease metadata/,
  );
});

test('contract v1: a dev candidate may ship services only, and then must omit the packages asset', () => {
  const m = candidate();
  m.packages = 'not_included';
  delete m.components.node;
  m.assets = m.assets.filter((asset) => asset.name !== 'packages.tar.gz');
  assert.deepEqual(validateManifest(m), []);
  m.assets.push({ name: 'packages.tar.gz', sha256: 'c'.repeat(64), size: 12 });
  assert.ok(validateManifest(m).includes('packages excluded but packages.tar.gz present'));
});

test('contract v1: production cannot exclude packages and the mode must be explicit', () => {
  const prod = candidate();
  prod.channel = 'prod';
  prod.packages = 'not_included';
  assert.ok(validateManifest(prod).includes('packages may be excluded only from the dev channel'));
  const unknown = candidate();
  unknown.packages = 'maybe';
  assert.ok(validateManifest(unknown).includes('invalid packages mode'));
});

test('contract v1b: a dev candidate may keep network on its running image', () => {
  const m = candidate();
  m.packages = 'not_included';
  m.network = 'unchanged';
  delete m.components.node;
  delete m.components.network;
  m.assets = m.assets.filter((asset) => asset.name !== 'packages.tar.gz');
  assert.deepEqual(validateManifest(m), []);
  m.components.network = {
    source_sha: 'a'.repeat(40),
    image: `ghcr.io/silicium-project/network@sha256:${'b'.repeat(64)}`,
  };
  assert.ok(validateManifest(m).includes('network component present but network is unchanged'));
});
