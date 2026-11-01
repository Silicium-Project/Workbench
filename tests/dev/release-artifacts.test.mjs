import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isQualifiedArtifactFromAttempt,
  qualifiedBuildArtifacts,
  releaseArtifactName,
} from '../../tools/lib/release-artifacts.mjs';
import { readJson } from '../../tools/lib/process.mjs';
import { writePreviousInstallBaseline } from '../../tools/lib/candidate-installation.mjs';

test('build outputs are unique to a validated workflow attempt', () => {
  assert.deepEqual(qualifiedBuildArtifacts(2), {
    api: 'api-binary-2',
    web: 'web-output-2',
    network: 'network-binaries-2',
    node: 'node-ui-output-2',
  });
  assert.notEqual(qualifiedBuildArtifacts(1).api, qualifiedBuildArtifacts(2).api);
});

test('temporary release artifact names include the current run attempt', () => {
  assert.equal(releaseArtifactName('candidate-input', '3'), 'candidate-input-3');
  assert.equal(isQualifiedArtifactFromAttempt('qualification-plan-3', 3), true);
  assert.equal(isQualifiedArtifactFromAttempt('report-solana-3', 3), true);
  assert.equal(isQualifiedArtifactFromAttempt('api-binary-3', 3), true);
  assert.equal(isQualifiedArtifactFromAttempt('api-binary-2', 3), false);
  assert.equal(isQualifiedArtifactFromAttempt('report-solana-2', 3), false);
});

test('artifact naming rejects invalid attempts and names', () => {
  for (const attempt of [0, -1, 'x', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => qualifiedBuildArtifacts(attempt), /workflow attempt/);
  assert.throws(() => releaseArtifactName('../candidate', 1), /artifact name/);
});

test('candidate preparation retains the signed package snapshot for upgrade tests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'silicium-candidate-baseline-'));
  try {
    const previous = {
      release_id: 'dev-0.2.9-dev.18-aaaaaaaaaaaa',
      components: { node: { version: '0.2.9-dev.18' } },
      assets: [{ name: 'packages.tar.gz', sha256: 'b'.repeat(64), size: 512 }],
      extra_metadata: 'not needed by the installer test',
    };
    assert.deepEqual(writePreviousInstallBaseline(directory, previous), {
      release_id: previous.release_id,
      components: previous.components,
      assets: previous.assets,
    });
    assert.deepEqual(readJson(join(directory, 'previous.json')), {
      release_id: previous.release_id,
      components: previous.components,
      assets: previous.assets,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('services-only previous releases carry no package upgrade baseline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'silicium-candidate-baseline-'));
  try {
    assert.equal(
      writePreviousInstallBaseline(directory, {
        release_id: 'dev-0.3.0-dev.13-0f564762c290',
        packages: 'not_included',
        components: { api: {}, web: {} },
        assets: [],
      }),
      null,
    );
    assert.equal(existsSync(join(directory, 'previous.json')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('first candidates remove stale package upgrade baselines and incomplete releases fail', () => {
  const directory = mkdtempSync(join(tmpdir(), 'silicium-candidate-baseline-'));
  try {
    writePreviousInstallBaseline(directory, {
      release_id: 'dev-0.2.9-dev.18-aaaaaaaaaaaa',
      components: { node: { version: '0.2.9-dev.18' } },
      assets: [{ name: 'packages.tar.gz', sha256: 'b'.repeat(64) }],
    });
    assert.equal(writePreviousInstallBaseline(directory, null), null);
    assert.equal(existsSync(join(directory, 'previous.json')), false);
    assert.throws(
      () =>
        writePreviousInstallBaseline(directory, {
          release_id: 'dev-0.2.9-dev.18-aaaaaaaaaaaa',
          components: { node: { version: '0.2.9-dev.18' } },
          assets: [],
        }),
      /Previous signed release lacks the package upgrade baseline/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public Workbench verifies private evidence without receiving private build artifacts', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const evidence = readFileSync(
    new URL('../../.github/workflows/private-integration-evidence.yml', import.meta.url),
    'utf8',
  );
  assert.match(ci, /name: qualification-plan-\$\{\{ github\.run_attempt \}\}/);
  assert.match(ci, /name: report-\$\{\{ matrix\.suite \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(ci, /pattern: report-\*-\$\{\{ github\.run_attempt \}\}/);
  assert.match(evidence, /workflow_call:/);
  assert.match(evidence, /integration\/evidence/);
  assert.match(evidence, /private-integration-evidence-\$\{\{ github\.run_attempt \}\}/);
  assert.equal((evidence.match(/actions\/download-artifact@/g) ?? []).length, 2);
  assert.equal((evidence.match(/digest-mismatch: error/g) ?? []).length, 2);
  assert.doesNotMatch(evidence, /delivery-(?:api|web|network|node-ui)-/);
  assert.equal(existsSync(new URL('../../.github/workflows/release.yml', import.meta.url)), false);
  assert.equal(
    existsSync(
      new URL('../../tools/config/integration-artifact-reader-app-manifest.json', import.meta.url),
    ),
    false,
  );
});
