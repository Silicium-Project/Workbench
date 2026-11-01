/** Candidate assembly uses qualified main artifacts. No PR artifact enters publication. */
import { readdirSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, run, readJson, writeJson, Failure } from '../lib/process.mjs';
import { publicApi, publicPages, repository } from '../lib/github.mjs';
import {
  sha256,
  requireManifest,
  compareVersions,
  verifyManifestAssetDirectory,
} from '../lib/manifest.mjs';
import { trustedReleaseBaseline } from '../lib/release-baseline.mjs';
import { writePreviousInstallBaseline } from '../lib/candidate-installation.mjs';
const operation = process.argv[2];
const dir = resolve(root, '.artifacts/candidate');
mkdirSync(dir, { recursive: true });
if (operation === 'prepare-private') {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== 'Silicium-Project/Integration' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_run' ||
    process.env.GITHUB_REF !== 'refs/heads/main'
  )
    throw new Failure(
      'Private candidate preparation is restricted to completed Integration main runs',
    );
  const verified = readJson(resolve(root, '.artifacts/private-integration/verified-input.json'));
  const source = run(['git', 'rev-parse', 'HEAD']).stdout.trim();
  const qualification = verified.qualification;
  if (
    verified.status !== 'verified' ||
    qualification?.repository !== 'Silicium-Project/Integration' ||
    qualification.workbench_sha !== source ||
    qualification.run_id !== process.env.QUALIFICATION_RUN_ID ||
    qualification.run_attempt !== Number(process.env.QUALIFICATION_ATTEMPT) ||
    qualification.run_number !== Number(process.env.QUALIFICATION_RUN_NUMBER) ||
    !qualification.integration_sha ||
    !verified.component_pins ||
    Object.keys(verified.component_pins).sort().join() !== 'api,network,node,solana,web'
  )
    throw new Failure('Private candidate identity differs from the verified qualification');
  const channel = process.env.RELEASE_CHANNEL ?? 'dev';
  const qualificationNumber = Number(process.env.QUALIFICATION_RUN_NUMBER);
  if (!['dev', 'prod'].includes(channel)) throw new Failure('Explicit release channel required');
  if (!Number.isSafeInteger(qualificationNumber) || qualificationNumber < 1)
    throw new Failure('The completed qualification run number is required');
  const releases = publicPages(`repos/${repository}/releases`);
  const { highestPublished, previous: prior } = trustedReleaseBaseline(releases, channel);
  let previous = null;
  if (prior) {
    const previousDir = resolve(dir, 'previous');
    mkdirSync(previousDir, { recursive: true });
    run([
      'gh',
      'release',
      'download',
      prior.tag_name,
      '--repo',
      repository,
      '--dir',
      previousDir,
      '--pattern',
      'manifest.json*',
    ]);
    run([
      'gpgv',
      '--keyring',
      resolve(root, 'contracts/trust/release.gpg'),
      resolve(previousDir, 'manifest.json.asc'),
      resolve(previousDir, 'manifest.json'),
    ]);
    previous = requireManifest(readJson(resolve(previousDir, 'manifest.json')));
    if (previous.channel !== channel || previous.release_id !== prior.tag_name)
      throw new Failure('Previous signed candidate identity mismatch');
    const ancestry = publicApi(`repos/${repository}/compare/${previous.source_sha}...${source}`);
    if (!['ahead', 'identical'].includes(ancestry.status))
      throw new Failure('Publication would cross unrelated or older Workbench history');
  }
  const version =
    channel === 'dev'
      ? `${readJson(resolve(root, 'tools/config/delivery.json')).base_version}-dev.${qualification.run_number}`
      : process.env.RELEASE_VERSION;
  if (channel === 'prod' && !/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Failure('Production version must be explicit');
  if (previous && compareVersions(version, previous.version) <= 0)
    throw new Failure('Candidate version must be newer than the preceding signed release');
  if (highestPublished && compareVersions(version, highestPublished.version) <= 0)
    throw new Failure(
      'Candidate version must be newer than every published release in its channel',
    );
  writePreviousInstallBaseline(dir, previous);
  const release_id = `${channel}-${version}-${source.slice(0, 12)}`;
  const existing = publicApi(
    `repos/${repository}/releases/tags/${encodeURIComponent(release_id)}`,
    { allowMissing: true },
  );
  if (existing)
    throw new Failure(
      'Candidate already published; promote the existing identity rather than replacing assets',
    );
  const changed = ['api', 'web', 'network', 'node'];
  const artifactNames = Object.fromEntries(
    verified.artifacts.map((artifact) => [artifact.suite, artifact.name]),
  );
  for (const suite of ['api', 'web', 'network', 'node_ui'])
    if (!artifactNames[suite]) throw new Failure(`Qualified ${suite} delivery artifact is missing`);
  writeJson(resolve(dir, 'inputs.json'), {
    changed,
    artifacts: {
      api: artifactNames.api,
      web: artifactNames.web,
      network: artifactNames.network,
      node: artifactNames.node_ui,
    },
    component_pins: verified.component_pins,
    policy_digest: verified.policy_digest,
    previous,
  });
  writeJson(resolve(dir, 'identity.json'), {
    schema_version: 1,
    source_sha: source,
    channel,
    version,
    release_id,
    qualification: {
      repository: 'Silicium-Project/Integration',
      workflow: '.github/workflows/qualification.yml',
      source_sha: source,
      workbench_sha: source,
      status: 'success',
      run_id: Number(qualification.run_id),
      run_attempt: Number(qualification.run_attempt),
      run_number: Number(qualification.run_number),
      integration_sha: qualification.integration_sha,
      policy_workflow_sha: qualification.policy_workflow_sha,
      policy_digest: verified.policy_digest,
      component_pins: verified.component_pins,
    },
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `source_sha=${source}\nrelease_id=${release_id}\nversion=${version}\nchannel=${channel}\nqualification_attempt=${qualification.run_attempt}\nqualification_run=${qualification.run_id}\nnode_changed=true\n`,
  );
} else if (operation === 'images') {
  const identity = readJson(resolve(dir, 'identity.json'));
  const inputs = readJson(resolve(dir, 'inputs.json'));
  const components = { ...(inputs.previous?.components ?? {}) };
  for (const component of ['api', 'web', 'network'].filter((c) => inputs.changed.includes(c))) {
    const pkg = publicApi(`orgs/Silicium-Project/packages/container/${component}`, {
      allowMissing: true,
    });
    // Images built from private component sources must never be public: a public image cannot be recalled.
    if (!pkg || pkg.visibility !== 'private')
      throw new Failure(
        'GHCR package must exist and be private before publication: images contain private source and must not be public (decision D15)',
      );
    const tag = `ghcr.io/silicium-project/${component}:${identity.release_id}`;
    const existing = run(['docker', 'buildx', 'imagetools', 'inspect', tag], {
      allowFailure: true,
    });
    if (!existing.status)
      throw new Failure(
        'Image identity already exists; start a fresh release run instead of overwriting it',
      );
    const digestFile = resolve(dir, `${component}.digest`);
    const dockerfile = `infra/images/${component}-runtime.Dockerfile`;
    run(
      [
        'docker',
        'buildx',
        'build',
        '--platform',
        'linux/amd64',
        '--provenance=mode=max',
        '--sbom=true',
        '--push',
        '--metadata-file',
        digestFile,
        '--label',
        `org.opencontainers.image.revision=${identity.source_sha}`,
        '--label',
        `org.opencontainers.image.version=${identity.version}`,
        '-f',
        dockerfile,
        '-t',
        tag,
        '.',
      ],
      { timeout: 3_600_000 },
    );
    const digest = readJson(digestFile)['containerimage.digest'];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ''))
      throw new Failure('Missing immutable image digest');
    components[component] = {
      source_sha: inputs.component_pins?.[component]?.commit ?? identity.source_sha,
      image: `ghcr.io/silicium-project/${component}@${digest}`,
      platform: 'linux-x86_64',
      qualification_run: identity.qualification.run_id,
    };
  }
  writeJson(resolve(dir, 'components.json'), components);
} else if (operation === 'manifest') {
  const identity = readJson(resolve(dir, 'identity.json'));
  const assetsDir = resolve(root, '.artifacts/publish');
  const verified = readJson(resolve(root, '.artifacts/private-integration/verified-input.json'));
  writeJson(resolve(assetsDir, 'qualification.json'), {
    schema_version: 1,
    evidence_type: 'silicium.private-integration-summary',
    status: 'success',
    integration: {
      run_id: identity.qualification.run_id,
      run_attempt: identity.qualification.run_attempt,
      commit: identity.qualification.integration_sha,
    },
    workbench: {
      source_sha: identity.source_sha,
      policy_workflow_sha: identity.qualification.policy_workflow_sha,
      policy_digest: identity.qualification.policy_digest,
      required_suites: verified.required_suites,
      component_pins: identity.qualification.component_pins,
    },
  });
  const assets = readdirSync(assetsDir)
    .filter((n) => n !== 'manifest.json' && n !== 'manifest.json.asc')
    .map((name) => {
      const bytes = readFileSync(resolve(assetsDir, name));
      return { name, size: bytes.length, sha256: sha256(bytes) };
    });
  const nodeInput = readJson(resolve(dir, 'inputs.json'));
  const components = readJson(resolve(dir, 'components.json'));
  if (nodeInput.changed.includes('node'))
    components.node = {
      source_sha: nodeInput.component_pins.node.commit,
      version: identity.version,
      channel: identity.channel,
      platforms: ['linux-x86_64', 'windows-x86_64'],
      qualification_run: identity.qualification.run_id,
    };
  components.solana = {
    source_sha: nodeInput.component_pins.solana.commit,
    qualification_run: identity.qualification.run_id,
  };
  const m = requireManifest({
    ...identity,
    policy_digest: identity.qualification.policy_digest,
    created_at: new Date().toISOString(),
    compatibility: { data_schema: 1, rollback: 'application-only', program_upgrade: false },
    components,
    assets,
  });
  writeJson(resolve(assetsDir, 'manifest.json'), m);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `manifest_digest=${sha256(readFileSync(resolve(assetsDir, 'manifest.json')))}\n`,
  );
} else if (operation === 'publish') {
  const assetsDir = resolve(root, '.artifacts/publish');
  const m = verifyManifestAssetDirectory(readJson(resolve(assetsDir, 'manifest.json')), assetsDir);
  run([
    'gpgv',
    '--keyring',
    resolve(root, 'contracts/trust/release.gpg'),
    resolve(assetsDir, 'manifest.json.asc'),
    resolve(assetsDir, 'manifest.json'),
  ]);
  const files = readdirSync(assetsDir).map((n) => resolve(assetsDir, n));
  run(
    [
      'gh',
      'release',
      'create',
      m.release_id,
      '--repo',
      repository,
      '--target',
      m.source_sha,
      '--title',
      m.release_id,
      '--notes',
      `Candidat qualifié : ${m.source_sha}\nQualification Integration : run ${m.qualification.run_id}, tentative ${m.qualification.run_attempt}`,
      ...(m.channel === 'dev' ? ['--prerelease'] : []),
      ...files,
    ],
    { timeout: 600_000 },
  );
  // The publisher App token causes the release event to trigger the protected Workbench deploy.
} else throw new Failure('Expected prepare-private|images|manifest|publish', 2);
