import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assertCanonicalSource,
  capture,
  gitTrackedContentSHA256,
  inspectDockerImage,
  inspectGitSource,
  requireDigestReference,
  sha256,
  sha256File,
} from './provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const emptySHA256 = sha256('');
const addonBuildPaths = [
  'package.json',
  'binding.gyp',
  'shell.js',
  'deps',
  'lib',
  'src',
];

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const stageName = process.argv[2];
const execute = process.argv.includes('--execute');
const reuseImages = process.argv.includes('--reuse-images');
const noncanonical = process.argv.includes('--noncanonical');
const canonical = !noncanonical;
const limit = integerOption('--limit');
const productCpusetOption = stringOption('--cpuset-cpus');
const postgresCpusetOption = stringOption('--postgres-cpuset-cpus');
const nodeImageOption = stringOption('--node-image');
const postgresImageOption = stringOption('--postgres-image');
if (!stageName || stageName.startsWith('--')) {
  throw new Error(
    'Usage: node scripts/run-docker.mjs <stage> [--execute] [--reuse-images] [--noncanonical] [--limit=N] [--cpuset-cpus=LIST] [--postgres-cpuset-cpus=LIST] [--node-image=NAME@sha256:DIGEST] [--postgres-image=NAME@sha256:DIGEST]',
  );
}

const [worktreeConfig, profiles, stages, runnerConfig] = await Promise.all([
  readJSON('config/worktrees.json'),
  readJSON('config/integration-profiles.json'),
  readJSON('config/integration-stages.json'),
  readJSON('config/runner.json'),
]);
for (const [profileName, profile] of Object.entries(profiles)) {
  validateAppResources(profileName, profile.docker);
}
const stage = stages[stageName];
if (!stage) {
  throw new Error(`Unknown stage ${stageName}`);
}
if (stage.status === 'definition-only-do-not-execute') {
  throw new Error(`${stageName} is definition-only and cannot be run`);
}
validateRunnerIsolation(runnerConfig.postgresIsolation);

const blocks = runBlocks(stage);
const allRuns = blocks.flatMap(block => block.runs);
const selectedBlocks = selectBlocks(blocks, limit);
const partialSelection = selectedBlocks.length !== blocks.length;
if (canonical && partialSelection) {
  throw new Error('Canonical mode requires the complete predeclared stage');
}
const selectedRuns = selectedBlocks.flatMap(block => block.runs);
const selectedProfiles = [...new Set(selectedRuns.map(run => run.profile))];
for (const profile of selectedProfiles) {
  if (!profiles[profile]) {
    throw new Error(`Unknown profile ${profile}`);
  }
  validateProfile(profile, profiles[profile], canonical);
}
validateAnalysisPlan(stage.analysisPlan, allRuns, stage.repetitions, canonical);

const postgresCpuset =
  postgresCpusetOption ?? stage.postgresCpusetCpus ?? undefined;
const runs = selectedRuns.map(runConfig =>
  resolvedRun(
    runConfig,
    profiles[runConfig.profile],
    stage,
    productCpusetOption,
    runnerConfig.postgresIsolation,
  ),
);
assertUniqueRunIDs(runs);
validateIsolation(runs, postgresCpuset, canonical);

const nodeImage = nodeImageOption ?? runnerConfig.baseImages?.node;
const postgresImage = postgresImageOption ?? runnerConfig.baseImages?.postgres;
if (canonical) {
  requireDigestReference('Node base image', nodeImage);
  requireDigestReference('PostgreSQL image', postgresImage);
}
if (!nodeImage || !postgresImage) {
  throw new Error('Node and PostgreSQL image references are required');
}

const worktreeLabels = [...new Set(runs.map(run => run.worktree))];
const addonWorktreeLabels = [
  ...new Set(runs.map(run => run.addonWorktree).filter(Boolean)),
];
const imageSpecs = uniqueImageSpecs(runs);
const [hashes, sourceEntries, addonSourceEntries] = await Promise.all([
  hashInputs(),
  Promise.all(
    worktreeLabels.map(async label => {
      const configured = worktreeConfig.worktrees[label];
      if (!configured) {
        throw new Error(`Unknown worktree ${label}`);
      }
      const path = join(worktreeConfig.benchmarkRoot, configured.path);
      const source = await inspectGitSource(path);
      if (canonical) {
        assertCanonicalSource(
          label,
          source,
          configured.commit ?? worktreeConfig.commit,
          configured.tree ?? worktreeConfig.tree,
        );
      }
      return [label, source];
    }),
  ),
  Promise.all(
    addonWorktreeLabels.map(async label => {
      const {configured, path} = addonConfiguration(worktreeConfig, label);
      const source = await inspectGitSource(path);
      source.buildContentSHA256 = gitTrackedContentSHA256(
        path,
        addonBuildPaths,
      );
      if (canonical) {
        assertCanonicalSource(
          `addon ${label}`,
          source,
          configured.commit,
          configured.tree,
        );
      }
      return [label, source];
    }),
  ),
]);
const sources = Object.fromEntries(sourceEntries);
const addonSources = Object.fromEntries(addonSourceEntries);
const generatedAt = new Date().toISOString();
const runToken = `${generatedAt.replaceAll(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`;
const expectedArtifacts = runs.map((runConfig, index) => ({
  path: join(
    'operations',
    `${String(index + 1).padStart(3, '0')}-${runID(runConfig)}.log`,
  ),
  kind: 'operation-log',
  runID: runID(runConfig),
  status: 'pending',
  sha256: null,
}));
const manifest = {
  schemaVersion: 2,
  stage: stageName,
  runToken,
  generatedAt,
  mode: canonical ? 'canonical' : 'noncanonical',
  execute,
  reuseImages,
  status: execute ? 'preparing' : 'dry-run',
  evidence: {
    eligible: false,
    classification: execute ? 'incomplete' : 'dry-run',
    reasons: execute ? ['execution is incomplete'] : ['dry run'],
  },
  platform: runnerConfig.platform,
  environment: null,
  ordering: stage.ordering ?? 'balanced',
  selection: {
    requestedLimit: limit ?? null,
    completeStage: !partialSelection,
    selectedBlocks: selectedBlocks.map(block => block.repetition),
    plannedBlocks: blocks.length,
    selectedRunCount: runs.length,
    plannedRunCount: allRuns.length,
  },
  processIsolation: {
    measuredOperationsPerContainer: 1,
    measuredOperationsPerVitestInvocation: 1,
    fileParallelism: false,
    maxWorkers: 1,
  },
  analysisPlan: stage.analysisPlan ?? null,
  baseImageReferences: {node: nodeImage, postgres: postgresImage},
  baseImages: {},
  inputHashes: hashes,
  sources,
  addonSources,
  addonBuildPolicy: {
    source: 'local-worktree-only',
    packagePublishing: false,
    npmCanaryFetch: false,
    platform: runnerConfig.platform,
  },
  images: {},
  postgresIsolation: runnerConfig.postgresIsolation,
  postgresConstraints: {
    cpus: 2,
    memory: '2g',
    cpusetCpus: postgresCpuset ?? null,
  },
  appResourceInvariant: {cpus: 1, memory: '3g', nodeHeapMB: 2304},
  expectedArtifacts,
  runs,
  operations: [],
};

console.log(
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${canonical ? 'CANONICAL' : 'NONCANONICAL'} ${stageName}: ${runs.length} ARM64 containers in ${selectedBlocks.length} complete blocks`,
);
for (const [index, runConfig] of runs.entries()) {
  console.log(
    `[${index + 1}/${runs.length}] ${runID(runConfig)} ${JSON.stringify(runConfig.constraints)}`,
  );
}
if (!execute) {
  process.exit(0);
}

const runDirectory = join(root, 'raw', `${stageName}-docker`, runToken);
const manifestPath = join(runDirectory, 'manifest.json');
await mkdir(dirname(runDirectory), {recursive: true});
await mkdir(runDirectory);
await mkdir(join(runDirectory, 'operations'));
await writeManifest();

let network;
try {
  run('docker', ['pull', '--platform', runnerConfig.platform, postgresImage]);
  run('docker', ['pull', '--platform', runnerConfig.platform, nodeImage]);
  manifest.environment = dockerEnvironment();
  manifest.baseImages.node = inspectDockerImage(nodeImage, root);
  manifest.baseImages.postgres = inspectDockerImage(postgresImage, root);
  if (canonical) {
    assertLinuxARM64('Node base image', manifest.baseImages.node);
    assertLinuxARM64('PostgreSQL image', manifest.baseImages.postgres);
  }
  for (const spec of imageSpecs) {
    const image = `zero-copy-pipeline-${slug(spec.key)}:local`;
    const expectedLabels = provenanceLabels(
      spec,
      sources[spec.worktree],
      spec.addonWorktree ? addonSources[spec.addonWorktree] : undefined,
      hashes,
      nodeImage,
      runnerConfig.platform,
    );
    if (!reuseImages) {
      const context = sources[spec.worktree].path;
      run('docker', [
        'build',
        '--platform',
        runnerConfig.platform,
        '--build-context',
        `benchmark=${root}`,
        ...(spec.addonWorktree
          ? [
              '--build-context',
              `addon=${addonSources[spec.addonWorktree].path}`,
            ]
          : []),
        '--file',
        join(root, spec.dockerfile),
        '--build-arg',
        `NODE_IMAGE=${nodeImage}`,
        ...Object.entries(expectedLabels).flatMap(([name, value]) => [
          '--label',
          `${name}=${value}`,
        ]),
        '--tag',
        image,
        context,
      ]);
    }
    const provenance = inspectDockerImage(image, root);
    if (canonical) {
      assertImageLabels(spec.key, provenance.labels, expectedLabels);
      assertLinuxARM64(`${spec.key} image`, provenance);
    }
    manifest.images[spec.key] = {
      tag: image,
      ...provenance,
      worktree: spec.worktree,
      addonWorktree: spec.addonWorktree,
      dockerfile: spec.dockerfile,
      buildInputs: imageBuildInputs(
        spec,
        sources[spec.worktree],
        spec.addonWorktree ? addonSources[spec.addonWorktree] : undefined,
        hashes,
        runnerConfig.platform,
      ),
      expectedLabels,
    };
  }
  manifest.status = 'running';
  await writeManifest();

  network = `zero-copy-pipeline-${process.pid}-${randomUUID().slice(0, 12)}`;
  run('docker', ['network', 'create', network]);
  for (let index = 0; index < runs.length; index++) {
    await executeOperation(index, runs[index]);
  }
  manifest.status = 'complete';
  manifest.completedAt = new Date().toISOString();
  manifest.evidence = evidenceStatus();
  await writeManifest();
} catch (error) {
  manifest.status = 'failed';
  manifest.failedAt = new Date().toISOString();
  manifest.failure = error instanceof Error ? error.message : String(error);
  manifest.evidence = {
    eligible: false,
    classification: 'incomplete',
    reasons: ['execution failed or is incomplete'],
  };
  await writeManifest();
  throw error;
} finally {
  if (network) {
    spawnSync('docker', ['network', 'rm', network], {encoding: 'utf8'});
  }
}

async function executeOperation(index, runConfig) {
  const id = runID(runConfig);
  const artifact = manifest.expectedArtifacts[index];
  const output = join(runDirectory, artifact.path);
  const suffix = `${process.pid}-${index + 1}-${randomUUID().slice(0, 8)}`;
  const postgres = `zero-copy-pipeline-pg-${suffix}`;
  const product = `zero-copy-pipeline-run-${suffix}`;
  const profile = profiles[runConfig.profile];
  let postgresStarted = false;
  let productStarted = false;
  let operation;
  try {
    const postgresArgs = [
      'run',
      '--detach',
      '--name',
      postgres,
      '--publish',
      '127.0.0.1::5432',
      '--network',
      network,
      '--network-alias',
      'postgres',
      '--memory',
      '2g',
      '--cpus',
      '2',
      ...(postgresCpuset ? ['--cpuset-cpus', postgresCpuset] : []),
      '--env',
      'POSTGRES_PASSWORD=postgres',
      manifest.baseImages.postgres.id,
      '-c',
      'wal_level=logical',
      '-c',
      'max_replication_slots=100',
      '-c',
      'max_wal_senders=100',
    ];
    run('docker', postgresArgs);
    postgresStarted = true;
    waitForPostgres(postgres);
    const portOutput = capture('docker', ['port', postgres, '5432/tcp']).trim();
    const hostPort = portOutput.slice(portOutput.lastIndexOf(':') + 1);
    const postgresInspect = inspectContainer(postgres);
    const systemIdentifier = capture(
      'docker',
      [
        'exec',
        postgres,
        'psql',
        '-U',
        'postgres',
        '-Atqc',
        'SELECT system_identifier FROM pg_control_system()',
      ],
      root,
    ).trim();
    const postgresBefore = containerCgroupSnapshot(postgres);
    const pgURI =
      runConfig.postgresTopology === 'host-port'
        ? `postgres://postgres:postgres@host.docker.internal:${hostPort}/postgres`
        : 'postgres://postgres:postgres@postgres:5432/postgres';
    const env = operationEnvironment(runConfig, profile, pgURI, id);
    const dockerArgs = [
      'run',
      '--name',
      product,
      '--init',
      '--network',
      network,
      '--platform',
      runnerConfig.platform,
      '--memory',
      runConfig.constraints.memory,
      '--memory-swap',
      runConfig.constraints.memory,
      '--cpus',
      String(runConfig.constraints.cpus),
      ...(runConfig.constraints.cpusetCpus
        ? ['--cpuset-cpus', runConfig.constraints.cpusetCpus]
        : []),
      '--pids-limit',
      '1024',
      ...Object.entries(env).flatMap(([name, value]) => [
        '--env',
        `${name}=${value}`,
      ]),
      manifest.images[runConfig.imageKey].id,
      'bash',
      '-lc',
      linuxCommand(),
    ];
    console.log(`[${index + 1}/${runs.length}] ${id}`);
    const startedAt = new Date().toISOString();
    productStarted = true;
    const result = spawnSync('docker', dockerArgs, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    const completedAt = new Date().toISOString();
    const productInspect = inspectContainer(product);
    const postgresAfter = containerCgroupSnapshot(postgres);
    operation = {
      index: index + 1,
      id,
      artifact: artifact.path,
      startedAt,
      completedAt,
      status: result.status,
      signal: result.signal,
      productContainer: containerRuntime(productInspect),
      postgres: {
        container: containerRuntime(postgresInspect),
        systemIdentifier,
        image: manifest.baseImages.postgres,
        sourceStrategy: runConfig.sourceStrategy,
        runnerIsolation: runnerConfig.postgresIsolation,
        cgroup: {
          before: postgresBefore,
          after: postgresAfter,
          delta: cgroupDelta(postgresBefore, postgresAfter),
        },
      },
    };
    const meta = {
      startedAt,
      id,
      runConfig,
      fixture: profile,
      constraints: runConfig.constraints,
      image: manifest.images[runConfig.imageKey],
      postgres: operation.postgres,
      cachePolicy: runConfig.cachePolicy,
      expected: runConfig.expected,
    };
    const text = [
      `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify(meta)}`,
      result.stdout ?? '',
      result.stderr ?? '',
      `ZERO_COPY_PIPELINE_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
    ].join('\n');
    await writeFile(output, text);
    artifact.status = result.status === 0 ? 'complete' : 'failed';
    artifact.sha256 = sha256(text);
    manifest.operations.push(operation);
    await writeManifest();
    if (result.status !== 0) {
      throw new Error(`Docker run failed: ${output}`);
    }
  } finally {
    if (productStarted) {
      spawnSync('docker', ['rm', '--force', '--volumes', product], {
        encoding: 'utf8',
      });
    }
    if (postgresStarted) {
      spawnSync('docker', ['rm', '--force', '--volumes', postgres], {
        encoding: 'utf8',
      });
    }
  }
}

function operationEnvironment(runConfig, profile, pgURI, id) {
  const expected = runConfig.expected;
  return {
    TEST_PG_17: pgURI,
    NODE_OPTIONS: `--max-old-space-size=${runConfig.constraints.nodeHeapMB}`,
    ZERO_COPY_PIPELINE_PROFILE: runConfig.profile,
    ZERO_COPY_PIPELINE_RUN_LABEL: id,
    ZERO_COPY_PIPELINE_FIXTURE: profile.fixture,
    ZERO_COPY_PIPELINE_FIXTURE_VERSION: profile.fixtureVersion,
    ZERO_COPY_PIPELINE_FIXTURE_SEED: String(profile.fixtureSeed),
    ZERO_COPY_PIPELINE_VALIDATION_MODE: profile.validationMode,
    ZERO_COPY_PIPELINE_ROWS: String(profile.rows),
    ZERO_COPY_PIPELINE_PAYLOAD_BYTES: String(profile.payloadBytes),
    ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES: String(
      runConfig.copyChunkBytes ?? profile.copyChunkBytes,
    ),
    ZERO_COPY_PIPELINE_EXPECTED_ROWS: String(expected.rowCount),
    ...(expected.copyBytes === null
      ? {}
      : {ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES: String(expected.copyBytes)}),
    ...(expected.copyDigest === null
      ? {}
      : {ZERO_COPY_PIPELINE_EXPECTED_COPY_DIGEST: expected.copyDigest}),
    ...(expected.contentDigest === null
      ? {}
      : {ZERO_COPY_PIPELINE_EXPECTED_CONTENT_DIGEST: expected.contentDigest}),
    ZERO_COPY_PIPELINE_CACHE_POLICY: stableStringify(runConfig.cachePolicy),
    ZERO_COPY_PIPELINE_SOURCE_STRATEGY: stableStringify({
      declared: runConfig.sourceStrategy,
      runner: runConfig.postgresIsolation,
    }),
    ZERO_COPY_PIPELINE_MODE: 'sync',
    ZERO_COPY_PIPELINE_WORKERS: String(runConfig.workerCount),
    ZERO_COPY_PIPELINE_PARTIAL_BATCHES: runConfig.partialInsertBatches
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_DIRECT_TEXT_BUFFERS: runConfig.directTextBuffers
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_EAGER_INDEXES: runConfig.eagerIndexes ? '1' : '0',
    ZERO_COPY_PIPELINE_EAGER_SECONDARY_INDEXES: runConfig.eagerSecondaryIndexes
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_ADAPTIVE_SECONDARY_INDEXES:
      runConfig.adaptiveSecondaryIndexes ? '1' : '0',
    ZERO_COPY_PIPELINE_INSTRUMENT_COPY_PHASES: runConfig.instrumentCopyPhases
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_REUSE_FIELD_BUFFERS:
      runConfig.reuseFragmentedFieldBuffers ? '1' : '0',
    ZERO_COPY_PIPELINE_NATIVE_TEXT_BUFFERS: runConfig.nativeTextBuffers
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_NATIVE_TEXT_STATIC: runConfig.nativeTextBufferStatic
      ? '1'
      : '0',
    ZERO_COPY_PIPELINE_BUFFER_MB: String(runConfig.bufferMB),
    ZERO_COPY_PIPELINE_SECONDARY_INDEX_MIN_AVERAGE_ROW_BYTES: String(
      runConfig.secondaryIndexMinAverageRowBytes ?? 0,
    ),
    ZERO_COPY_PIPELINE_MMAP_GIB: String(runConfig.cacheSettings.mmapGiB),
    ...(runConfig.cacheSettings.sqliteCacheMB === undefined
      ? {}
      : {
          ZERO_COPY_PIPELINE_SQLITE_CACHE_MB: String(
            runConfig.cacheSettings.sqliteCacheMB,
          ),
        }),
    ZERO_COPY_PIPELINE_INSTRUMENT: '1',
  };
}

function linuxCommand() {
  const cgroupScript = String.raw`
    const fs = require('node:fs');
    const path = '/tmp/zero-copy-pipeline-cgroup-before.json';
    const read = name => {
      try { return fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim(); }
      catch { return null; }
    };
    const number = value => value !== null && /^-?\d+$/.test(value) ? Number(value) : value;
    const pairs = value => value === null ? null : Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [key, raw] = line.split(/\s+/, 2);
      return [key, number(raw)];
    }));
    const pressure = value => value === null ? null : Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [kind, ...fields] = line.split(/\s+/);
      return [kind, Object.fromEntries(fields.map(field => {
        const [key, raw] = field.split('=');
        return [key, number(raw)];
      }))];
    }));
    const io = value => value === null ? null : Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [device, ...fields] = line.split(/\s+/);
      return [device, Object.fromEntries(fields.map(field => {
        const [key, raw] = field.split('=');
        return [key, number(raw)];
      }))];
    }));
    const snapshot = () => ({
      capturedAt: new Date().toISOString(),
      cpu: {
        cpusetCpus: read('cpuset.cpus'),
        cpusetCpusEffective: read('cpuset.cpus.effective'),
        max: read('cpu.max'),
        stat: pairs(read('cpu.stat')),
        statLocal: pairs(read('cpu.stat.local')),
        pressure: pressure(read('cpu.pressure')),
      },
      memory: {
        current: number(read('memory.current')),
        max: number(read('memory.max')),
        peak: number(read('memory.peak')),
        events: pairs(read('memory.events')),
        eventsLocal: pairs(read('memory.events.local')),
        pressure: pressure(read('memory.pressure')),
      },
      io: {
        stat: io(read('io.stat')),
        pressure: pressure(read('io.pressure')),
      },
    });
    const subtract = (before, after) => {
      if (typeof before === 'number' && typeof after === 'number') return after - before;
      if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
      return Object.fromEntries(Object.keys(after).map(key => [key, subtract(before[key], after[key])]).filter(([, value]) => value !== null));
    };
    if (process.argv[1] === 'before') {
      fs.writeFileSync(path, JSON.stringify(snapshot()));
    } else {
      const before = JSON.parse(fs.readFileSync(path, 'utf8'));
      const after = snapshot();
      console.log('ZERO_COPY_PIPELINE_CGROUP ' + JSON.stringify({
        scope: 'one-container-operation',
        before,
        after,
        delta: subtract(before, after),
      }));
    }
  `;
  return [
    `node --input-type=commonjs -e ${shellQuote(cgroupScript)} before`,
    'status=0',
    '/usr/bin/time -v ./node_modules/.bin/vitest run src/initial-sync-copy-pipeline.product.bench.pg.ts --config vitest.config.bench.pg.ts -t "initial sync copy pipeline investigation" --pool=forks --maxWorkers=1 --no-file-parallelism || status=$?',
    `node --input-type=commonjs -e ${shellQuote(cgroupScript)} after`,
    'exit $status',
  ].join('; ');
}

function runBlocks(stageConfig) {
  if (
    !Array.isArray(stageConfig.profiles) ||
    !Array.isArray(stageConfig.treatments) ||
    !Number.isInteger(stageConfig.repetitions) ||
    stageConfig.repetitions < 1
  ) {
    throw new Error(
      'Runnable stage must declare profiles, treatments, and repetitions',
    );
  }
  if (
    stageConfig.profiles.length === 0 ||
    stageConfig.treatments.length === 0
  ) {
    throw new Error('Runnable stage profiles and treatments cannot be empty');
  }
  if (
    stageConfig.ordering === 'paired-ab-ba' &&
    stageConfig.treatments.length !== 2
  ) {
    throw new Error('paired-ab-ba ordering requires exactly two treatments');
  }
  const cases = stageConfig.profiles.flatMap(profile =>
    stageConfig.treatments.map(treatment => ({profile, ...treatment})),
  );
  return Array.from({length: stageConfig.repetitions}, (_, index) => {
    const repetition = index + 1;
    let ordered;
    if (stageConfig.ordering === 'paired-ab-ba') {
      const orderedProfiles =
        repetition % 2 === 1
          ? stageConfig.profiles
          : [...stageConfig.profiles].reverse();
      const orderedTreatments =
        repetition % 2 === 1
          ? stageConfig.treatments
          : [...stageConfig.treatments].reverse();
      ordered = orderedProfiles.flatMap(profile =>
        orderedTreatments.map(treatment => ({profile, ...treatment})),
      );
    } else if (stageConfig.ordering === 'forward-reverse') {
      ordered = repetition % 2 === 1 ? cases : [...cases].reverse();
    } else {
      const offset = (repetition - 1) % cases.length;
      const rotated = cases.slice(offset).concat(cases.slice(0, offset));
      ordered = repetition % 2 === 1 ? rotated : rotated.reverse();
    }
    return {
      repetition,
      runs: ordered.map(runConfig => ({...runConfig, repetition})),
    };
  });
}

function selectBlocks(blocks, requestedLimit) {
  if (requestedLimit === undefined) {
    return blocks;
  }
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('--limit must be a positive integer run count');
  }
  let count = 0;
  for (let index = 0; index < blocks.length; index++) {
    count += blocks[index].runs.length;
    if (count === requestedLimit) {
      return blocks.slice(0, index + 1);
    }
    if (count > requestedLimit) {
      break;
    }
  }
  throw new Error(
    `--limit=${requestedLimit} splits a balanced block or exceeds the ${count} planned runs`,
  );
}

function resolvedRun(
  runConfig,
  profile,
  stageConfig,
  cpusetOption,
  postgresIsolation,
) {
  const workerCount =
    runConfig.workerCount ?? stageConfig.workerCount ?? profile.workerCount;
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
    throw new Error(`${runConfig.profile} must resolve a positive workerCount`);
  }
  const cpusetCpus =
    cpusetOption ??
    runConfig.cpusetCpus ??
    profile.docker.cpusetCpus ??
    stageConfig.cpusetCpus ??
    null;
  const declaredCachePolicy =
    runConfig.cachePolicy ?? stageConfig.cachePolicy ?? profile.cachePolicy;
  const cacheSettings = {
    mmapGiB: runConfig.mmapGiB ?? declaredCachePolicy.mmapGiB,
    ...(runConfig.cacheMB === undefined
      ? {}
      : {sqliteCacheMB: runConfig.cacheMB}),
  };
  if (
    !Number.isSafeInteger(cacheSettings.mmapGiB) ||
    cacheSettings.mmapGiB < 0
  ) {
    throw new Error(`${runConfig.profile} must resolve cacheSettings.mmapGiB`);
  }
  return {
    ...runConfig,
    imageKey: imageSpecForRun(runConfig).key,
    workerCount,
    canonical: profile.canonical,
    validationMode: profile.validationMode,
    fixtureIdentity: {
      version: profile.fixtureVersion,
      seed: profile.fixtureSeed,
    },
    cachePolicy: {
      declared: declaredCachePolicy,
      effective: cacheSettings,
    },
    cacheSettings,
    sourceStrategy: profile.sourceStrategy,
    postgresIsolation,
    expected: profile.expected,
    constraints: {
      ...profile.docker,
      cpusetCpus,
      cpuQuota: profile.docker.cpus,
    },
  };
}

function validateProfile(name, profile, canonicalRunner) {
  if (typeof profile.canonical !== 'boolean') {
    throw new Error(`${name}.canonical must be boolean`);
  }
  if (
    !['canonical', 'calibration', 'exploratory'].includes(
      profile.validationMode,
    ) ||
    profile.canonical !== (profile.validationMode === 'canonical')
  ) {
    throw new Error(`${name} canonical and validationMode fields disagree`);
  }
  if (canonicalRunner && !profile.canonical) {
    throw new Error(
      `${name} is ${profile.validationMode}, not an approved canonical profile`,
    );
  }
  if (
    typeof profile.fixtureVersion !== 'string' ||
    !Number.isSafeInteger(profile.fixtureSeed) ||
    !Number.isSafeInteger(profile.workerCount) ||
    profile.workerCount < 1
  ) {
    throw new Error(`${name} has an invalid fixture identity or workerCount`);
  }
  validateAppResources(name, profile.docker);
  if (!isRecord(profile.cachePolicy) || !profile.cachePolicy.betweenRuns) {
    throw new Error(`${name} must declare cachePolicy.betweenRuns`);
  }
  if (
    typeof profile.cachePolicy.osPageCache !== 'string' ||
    !Number.isSafeInteger(profile.cachePolicy.mmapGiB) ||
    profile.cachePolicy.mmapGiB < 0
  ) {
    throw new Error(`${name} must declare its page-cache and mmap policies`);
  }
  if (
    !isRecord(profile.sourceStrategy) ||
    typeof profile.sourceStrategy.clone !== 'string' ||
    typeof profile.sourceStrategy.reset !== 'string'
  ) {
    throw new Error(`${name} must declare source clone and reset strategies`);
  }
  if (!isRecord(profile.expected)) {
    throw new Error(`${name} must declare exact expectations`);
  }
  if (
    profile.expected.rowCount !== profile.rows ||
    profile.expected.copyBytes !== profile.expectedCopyBytes
  ) {
    throw new Error(
      `${name} expected rows/copy bytes do not match the fixture`,
    );
  }
  for (const key of ['copyDigest', 'contentDigest']) {
    const value = profile.expected[key];
    if (value !== null && !/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${name}.expected.${key} is not a sha256 digest`);
    }
  }
  if (
    profile.canonical &&
    Object.values(profile.expected).some(value => value === null)
  ) {
    throw new Error(`${name} canonical expectations must all be exact`);
  }
  if (
    canonicalRunner &&
    (profile.sourceStrategy.clone !== 'regenerate-isolated-database' ||
      profile.sourceStrategy.reset !== 'drop-database-after-run')
  ) {
    throw new Error(
      `${name} source strategy is not implemented by this canonical runner`,
    );
  }
}

function validateAnalysisPlan(plan, allRuns, repetitions, canonicalRunner) {
  if (plan === undefined) {
    if (canonicalRunner) {
      throw new Error(
        'Canonical mode requires a predeclared stage.analysisPlan',
      );
    }
    return;
  }
  if (!isRecord(plan)) {
    throw new Error('analysisPlan must be an object');
  }
  for (const key of [
    'plannedSampleCount',
    'plannedBlocks',
    'minimumPairedBlocks',
    'bootstrapResamples',
  ]) {
    if (
      plan[key] !== undefined &&
      (!Number.isSafeInteger(plan[key]) || plan[key] < 1)
    ) {
      throw new Error(`analysisPlan.${key} must be a positive integer`);
    }
  }
  if (plan.plannedSampleCount !== allRuns.length) {
    throw new Error(
      `analysisPlan.plannedSampleCount must exactly equal ${allRuns.length}`,
    );
  }
  if (plan.plannedBlocks !== undefined && plan.plannedBlocks !== repetitions) {
    throw new Error(
      `analysisPlan.plannedBlocks must exactly equal ${repetitions}`,
    );
  }
  if (
    plan.minimumPairedBlocks !== undefined &&
    plan.minimumPairedBlocks > repetitions
  ) {
    throw new Error(
      'analysisPlan.minimumPairedBlocks cannot exceed planned repetitions',
    );
  }
  if (plan.plannedBlocksByCondition !== undefined) {
    if (!isRecord(plan.plannedBlocksByCondition)) {
      throw new Error(
        'analysisPlan.plannedBlocksByCondition must be an object',
      );
    }
    for (const value of Object.values(plan.plannedBlocksByCondition)) {
      if (!Number.isSafeInteger(value) || value !== repetitions) {
        throw new Error(
          `analysisPlan planned blocks by condition must exactly equal ${repetitions}`,
        );
      }
    }
  }
}

function validateRunnerIsolation(isolation) {
  if (
    !isRecord(isolation) ||
    isolation.strategy !== 'fresh-container-per-operation' ||
    isolation.reset !== 'new-empty-data-directory' ||
    isolation.scope !== 'arm-and-repetition'
  ) {
    throw new Error(
      'This runner only implements a fresh empty PostgreSQL container per arm and repetition',
    );
  }
}

function validateIsolation(runConfigs, postgresCpusetCpus, canonicalRunner) {
  const postgresSet = postgresCpusetCpus
    ? parseCpuset(postgresCpusetCpus)
    : undefined;
  if (canonicalRunner && !postgresSet) {
    throw new Error('Canonical mode requires --postgres-cpuset-cpus');
  }
  for (const runConfig of runConfigs) {
    const value = runConfig.constraints.cpusetCpus;
    const productSet = value ? parseCpuset(value) : undefined;
    if (canonicalRunner && !productSet) {
      throw new Error(
        `Canonical mode requires a product cpuset for ${runID(runConfig)}`,
      );
    }
    if (productSet && productSet.size < Math.ceil(runConfig.constraints.cpus)) {
      throw new Error(
        `${runID(runConfig)} cpuset has fewer CPUs than its CPU quota`,
      );
    }
    if (canonicalRunner && [...productSet].some(cpu => postgresSet.has(cpu))) {
      throw new Error(
        `${runID(runConfig)} product and PostgreSQL cpusets overlap`,
      );
    }
  }
}

function parseCpuset(value) {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) {
    throw new Error(`Invalid CPU set ${value}`);
  }
  const cpus = new Set();
  for (const part of value.split(',')) {
    const [startText, endText = startText] = part.split('-');
    const start = Number(startText);
    const end = Number(endText);
    if (end < start) {
      throw new Error(`Invalid CPU set range ${part}`);
    }
    for (let cpu = start; cpu <= end; cpu++) {
      cpus.add(cpu);
    }
  }
  return cpus;
}

function assertUniqueRunIDs(runConfigs) {
  const ids = new Set();
  for (const runConfig of runConfigs) {
    const id = runID(runConfig);
    if (ids.has(id)) {
      throw new Error(`Stage declares duplicate operation ${id}`);
    }
    ids.add(id);
  }
}

async function hashInputs() {
  const paths = {
    initialSyncHarness: 'src/initial-sync-copy-pipeline.product.bench.pg.ts',
    parserHarness: 'src/pg-copy-parser.product.bench.ts',
    dockerfile: 'Dockerfile.linux',
    addonDockerfile: 'Dockerfile.addon-experiment.linux',
    addonLinker: 'scripts/link-local-addon.mjs',
    runner: 'scripts/run-docker.mjs',
    provenance: 'scripts/provenance.mjs',
    worktrees: 'config/worktrees.json',
    profiles: 'config/integration-profiles.json',
    stages: 'config/integration-stages.json',
    runnerConfig: 'config/runner.json',
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        {path, sha256: await sha256File(join(root, path))},
      ]),
    ),
  );
}

function provenanceLabels(
  spec,
  source,
  addonSource,
  hashes,
  nodeImage,
  platform,
) {
  const buildInputs = imageBuildInputs(
    spec,
    source,
    addonSource,
    hashes,
    platform,
  );
  return {
    'dev.rocicorp.zero-benchmark.worktree': spec.worktree,
    'dev.rocicorp.zero-benchmark.source-commit': source.commit,
    'dev.rocicorp.zero-benchmark.source-tree': source.tree,
    'dev.rocicorp.zero-benchmark.source-diff-sha256': source.diffSHA256,
    'dev.rocicorp.zero-benchmark.source-content-sha256': source.contentSHA256,
    'dev.rocicorp.zero-benchmark.harness-sha256':
      hashes.initialSyncHarness.sha256,
    'dev.rocicorp.zero-benchmark.config-sha256': hashes.profiles.sha256,
    'dev.rocicorp.zero-benchmark.runner-sha256': hashes.runner.sha256,
    'dev.rocicorp.zero-benchmark.node-image': nodeImage,
    'dev.rocicorp.zero-benchmark.build-inputs-sha256': buildInputs.sha256,
    ...(spec.addonWorktree
      ? {
          'dev.rocicorp.zero-benchmark.addon-worktree': spec.addonWorktree,
          'dev.rocicorp.zero-benchmark.addon-commit': addonSource.commit,
          'dev.rocicorp.zero-benchmark.addon-tree': addonSource.tree,
          'dev.rocicorp.zero-benchmark.addon-diff-sha256':
            addonSource.diffSHA256,
          'dev.rocicorp.zero-benchmark.addon-content-sha256':
            addonSource.contentSHA256,
          'dev.rocicorp.zero-benchmark.addon-build-content-sha256':
            addonSource.buildContentSHA256,
          'dev.rocicorp.zero-benchmark.addon-linker-sha256':
            hashes.addonLinker.sha256,
          'dev.rocicorp.zero-benchmark.addon-platform': platform,
        }
      : {}),
  };
}

function imageBuildInputs(spec, source, addonSource, hashes, platform) {
  const inputs = {
    platform,
    dockerfile: hashes[spec.addonWorktree ? 'addonDockerfile' : 'dockerfile'],
    mono: sourceIdentity(source),
    ...(spec.addonWorktree
      ? {
          addon: {
            worktree: spec.addonWorktree,
            ...sourceIdentity(addonSource),
            buildContentSHA256: addonSource.buildContentSHA256,
            copiedPaths: addonBuildPaths,
          },
          linkHelper: hashes.addonLinker,
        }
      : {}),
  };
  return {...inputs, sha256: sha256(stableStringify(inputs))};
}

function sourceIdentity(source) {
  return {
    commit: source.commit,
    tree: source.tree,
    diffSHA256: source.diffSHA256,
    trackedContentSHA256: source.trackedContentSHA256,
    contentSHA256: source.contentSHA256,
  };
}

function imageSpecForRun(runConfig) {
  const addonWorktree = runConfig.addonWorktree ?? null;
  return {
    key: addonWorktree
      ? `${runConfig.worktree}-addon-${addonWorktree}`
      : runConfig.worktree,
    worktree: runConfig.worktree,
    addonWorktree,
    dockerfile: addonWorktree
      ? 'Dockerfile.addon-experiment.linux'
      : 'Dockerfile.linux',
  };
}

function uniqueImageSpecs(runConfigs) {
  return [
    ...new Map(
      runConfigs.map(runConfig => {
        const spec = imageSpecForRun(runConfig);
        return [spec.key, spec];
      }),
    ).values(),
  ];
}

function addonConfiguration(config, label) {
  if (
    typeof config.addonRoot !== 'string' ||
    !isRecord(config.addonWorktrees)
  ) {
    throw new Error('Addon treatments require config.addonRoot/addonWorktrees');
  }
  const configured = config.addonWorktrees[label];
  if (
    !isRecord(configured) ||
    configured.label !== label ||
    typeof configured.path !== 'string'
  ) {
    throw new Error(`Unknown addon worktree ${label}`);
  }
  return {configured, path: join(config.addonRoot, configured.path)};
}

function validateAppResources(name, resources) {
  if (
    !isRecord(resources) ||
    resources.cpus !== 1 ||
    resources.memory !== '3g' ||
    resources.nodeHeapMB !== 2304
  ) {
    throw new Error(
      `${name} app resources must be exactly 1 CPU, 3g memory, and 2304 MB Node heap`,
    );
  }
}

function assertImageLabels(label, actual, expected) {
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) {
      throw new Error(
        `${label} image provenance ${name} is ${actual[name] ?? '<missing>'}; expected ${value}`,
      );
    }
  }
}

function assertLinuxARM64(label, image) {
  if (image.os !== 'linux' || image.architecture !== 'arm64') {
    throw new Error(
      `${label} is ${image.os}/${image.architecture}; expected linux/arm64`,
    );
  }
}

function dockerEnvironment() {
  const server = JSON.parse(
    capture('docker', ['version', '--format', '{{json .Server}}'], root),
  );
  const info = JSON.parse(
    capture(
      'docker',
      [
        'info',
        '--format',
        '{"id":{{json .ID}},"driver":{{json .Driver}},"cgroupDriver":{{json .CgroupDriver}},"cgroupVersion":{{json .CgroupVersion}},"kernelVersion":{{json .KernelVersion}},"operatingSystem":{{json .OperatingSystem}},"architecture":{{json .Architecture}},"nCPU":{{json .NCPU}},"memoryBytes":{{json .MemTotal}}}',
      ],
      root,
    ),
  );
  return {dockerServer: server, dockerInfo: info};
}

function inspectContainer(container) {
  const [value] = JSON.parse(
    capture('docker', ['container', 'inspect', container], root),
  );
  return value;
}

function containerRuntime(value) {
  return {
    id: value.Id,
    imageID: value.Image,
    created: value.Created,
    state: {
      status: value.State?.Status,
      exitCode: value.State?.ExitCode,
      oomKilled: value.State?.OOMKilled,
    },
    constraints: {
      cpusetCpus: value.HostConfig?.CpusetCpus || null,
      nanoCpus: value.HostConfig?.NanoCpus,
      memory: value.HostConfig?.Memory,
      memorySwap: value.HostConfig?.MemorySwap,
      pidsLimit: value.HostConfig?.PidsLimit,
    },
  };
}

function containerCgroupSnapshot(container) {
  const read = name => {
    const result = spawnSync(
      'docker',
      ['exec', container, 'cat', `/sys/fs/cgroup/${name}`],
      {encoding: 'utf8'},
    );
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return parseCgroupSnapshot(read);
}

function parseCgroupSnapshot(read) {
  return {
    capturedAt: new Date().toISOString(),
    cpu: {
      cpusetCpus: read('cpuset.cpus'),
      cpusetCpusEffective: read('cpuset.cpus.effective'),
      max: read('cpu.max'),
      stat: parsePairs(read('cpu.stat')),
      pressure: parsePressure(read('cpu.pressure')),
    },
    memory: {
      current: numeric(read('memory.current')),
      max: numeric(read('memory.max')),
      peak: numeric(read('memory.peak')),
      events: parsePairs(read('memory.events')),
      eventsLocal: parsePairs(read('memory.events.local')),
      pressure: parsePressure(read('memory.pressure')),
    },
    io: {
      stat: parseIO(read('io.stat')),
      pressure: parsePressure(read('io.pressure')),
    },
  };
}

function parsePairs(value) {
  return value === null
    ? null
    : Object.fromEntries(
        value
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [key, raw] = line.split(/\s+/, 2);
            return [key, numeric(raw)];
          }),
      );
}

function parsePressure(value) {
  return value === null
    ? null
    : Object.fromEntries(
        value
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [kind, ...fields] = line.split(/\s+/);
            return [
              kind,
              Object.fromEntries(
                fields.map(field => {
                  const [key, raw] = field.split('=');
                  return [key, numeric(raw)];
                }),
              ),
            ];
          }),
      );
}

function parseIO(value) {
  return value === null
    ? null
    : Object.fromEntries(
        value
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [device, ...fields] = line.split(/\s+/);
            return [
              device,
              Object.fromEntries(
                fields.map(field => {
                  const [key, raw] = field.split('=');
                  return [key, numeric(raw)];
                }),
              ),
            ];
          }),
      );
}

function numeric(value) {
  return value !== null && /^-?\d+$/.test(value) ? Number(value) : value;
}

function cgroupDelta(before, after) {
  if (typeof before === 'number' && typeof after === 'number') {
    return after - before;
  }
  if (!isRecord(before) || !isRecord(after)) {
    return null;
  }
  return Object.fromEntries(
    Object.keys(after)
      .map(key => [key, cgroupDelta(before[key], after[key])])
      .filter(([, value]) => value !== null),
  );
}

function evidenceStatus() {
  const reasons = [];
  if (!canonical) {
    reasons.push('runner was explicitly noncanonical');
  }
  if (partialSelection) {
    reasons.push('stage selection is incomplete');
  }
  if (!stage.analysisPlan) {
    reasons.push('stage has no predeclared analysis plan');
  }
  if (runs.some(run => run.validationMode !== 'canonical')) {
    reasons.push('one or more fixture profiles are not canonical');
  }
  if (expectedArtifacts.some(artifact => artifact.status !== 'complete')) {
    reasons.push('one or more expected artifacts are incomplete');
  }
  return {
    eligible: reasons.length === 0,
    classification:
      reasons.length === 0 ? 'canonical-complete' : 'noncanonical',
    reasons,
  };
}

async function writeManifest() {
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, manifestPath);
}

function runID(runConfig) {
  return `${slug(runConfig.profile)}-${slug(runConfig.label ?? runConfig.worktree)}-r${runConfig.repetition}`;
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres'],
      {encoding: 'utf8'},
    );
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('Postgres did not become ready');
}

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', stdio: 'inherit'});
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-');
}

function stringOption(name) {
  const prefix = `${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function integerOption(name) {
  const value = stringOption(name);
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return Number(value);
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

function selfTest() {
  const treatments = [
    {worktree: 'a', label: 'a'},
    {worktree: 'b', label: 'b'},
  ];
  const stageConfig = {
    profiles: ['p1', 'p2'],
    treatments,
    repetitions: 2,
    ordering: 'paired-ab-ba',
  };
  const blocks = runBlocks(stageConfig);
  assert.deepEqual(
    blocks[0].runs.map(run => run.label),
    ['a', 'b', 'a', 'b'],
  );
  assert.deepEqual(
    blocks[1].runs.map(run => run.label),
    ['b', 'a', 'b', 'a'],
  );
  assert.equal(selectBlocks(blocks, 4).length, 1);
  assert.throws(() => selectBlocks(blocks, 3), /splits a balanced block/);
  assert.throws(
    () => assertUniqueRunIDs([blocks[0].runs[0], blocks[0].runs[0]]),
    /duplicate/,
  );
  assert.deepEqual([...parseCpuset('0-2,4')], [0, 1, 2, 4]);
  assert.throws(() => parseCpuset('2-1'), /Invalid CPU set/);
  const isolatedRun = {
    profile: 'p1',
    label: 'a',
    repetition: 1,
    constraints: {cpusetCpus: '0-1', cpus: 2},
  };
  assert.doesNotThrow(() => validateIsolation([isolatedRun], '2-3', true));
  assert.throws(() => validateIsolation([isolatedRun], '1-2', true), /overlap/);
  assert.doesNotThrow(() =>
    requireDigestReference('test', `image@sha256:${'a'.repeat(64)}`),
  );
  assert.throws(
    () => requireDigestReference('test', 'image:latest'),
    /immutable/,
  );
  const source = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    clean: true,
    status: '',
    diffSHA256: 'c'.repeat(64),
    trackedContentSHA256: 'd'.repeat(64),
    contentSHA256: 'e'.repeat(64),
    buildContentSHA256: '1'.repeat(64),
  };
  assert.doesNotThrow(() =>
    assertCanonicalSource('test', source, 'a'.repeat(40), 'b'.repeat(40)),
  );
  assert.throws(
    () => assertCanonicalSource('test', source, 'a'.repeat(8), 'b'.repeat(40)),
    /full 40-character ID/,
  );
  assert.throws(
    () =>
      assertCanonicalSource(
        'test',
        {...source, clean: false, status: '?? source.ts'},
        'a'.repeat(40),
        'b'.repeat(40),
      ),
    /dirty or untracked/,
  );
  assert.doesNotThrow(() =>
    validateAnalysisPlan(
      {plannedSampleCount: 8, plannedBlocks: 2},
      blocks.flatMap(block => block.runs),
      2,
      true,
    ),
  );
  assert.throws(
    () => validateAnalysisPlan(undefined, [], 1, true),
    /predeclared/,
  );
  const addonConfig = {
    addonRoot: '/addons',
    addonWorktrees: {addon: {label: 'addon', path: 'branch'}},
  };
  assert.deepEqual(addonConfiguration(addonConfig, 'addon'), {
    configured: addonConfig.addonWorktrees.addon,
    path: '/addons/branch',
  });
  assert.throws(
    () => addonConfiguration(addonConfig, 'missing'),
    /Unknown addon worktree/,
  );
  const genericSpec = imageSpecForRun({worktree: 'mono'});
  const addonSpec = imageSpecForRun({
    worktree: 'mono',
    addonWorktree: 'addon',
  });
  assert.equal(genericSpec.dockerfile, 'Dockerfile.linux');
  assert.equal(addonSpec.dockerfile, 'Dockerfile.addon-experiment.linux');
  assert.equal(
    uniqueImageSpecs([
      {worktree: 'mono', addonWorktree: 'addon', label: 'native-disabled'},
      {worktree: 'mono', addonWorktree: 'addon', label: 'native-enabled'},
    ]).length,
    1,
  );
  const inputHash = {path: 'input', sha256: 'f'.repeat(64)};
  const addonLabels = provenanceLabels(
    addonSpec,
    source,
    source,
    {
      initialSyncHarness: inputHash,
      profiles: inputHash,
      runner: inputHash,
      dockerfile: inputHash,
      addonDockerfile: inputHash,
      addonLinker: inputHash,
    },
    `node@sha256:${'0'.repeat(64)}`,
    'linux/arm64',
  );
  assert.equal(
    addonLabels['dev.rocicorp.zero-benchmark.addon-worktree'],
    'addon',
  );
  assert.equal(
    addonLabels['dev.rocicorp.zero-benchmark.addon-content-sha256'],
    source.contentSHA256,
  );
  assert.equal(
    addonLabels['dev.rocicorp.zero-benchmark.addon-build-content-sha256'],
    source.buildContentSHA256,
  );
  assert.doesNotThrow(() =>
    validateAppResources('test', {
      cpus: 1,
      memory: '3g',
      nodeHeapMB: 2304,
    }),
  );
  assert.throws(
    () =>
      validateAppResources('test', {
        cpus: 2,
        memory: '3g',
        nodeHeapMB: 2304,
      }),
    /exactly 1 CPU/,
  );
  assert.equal(
    emptySHA256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  console.log('run-docker self-test passed');
}
