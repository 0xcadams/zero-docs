import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageName = process.argv[2];
const execute = process.argv.includes('--execute');
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;
if (!stageName || stageName.startsWith('--')) {
  throw new Error(
    'Usage: node scripts/run-docker.mjs <stage> [--execute] [--limit=N]',
  );
}

const [worktreeConfig, profiles, stages] = await Promise.all([
  readJSON('config/worktrees.json'),
  readJSON('config/integration-profiles.json'),
  readJSON('config/integration-stages.json'),
]);
const stage = stages[stageName];
if (!stage) {
  throw new Error(`Unknown stage ${stageName}`);
}
const cases = stage.profiles.flatMap(profile =>
  stage.treatments.map(treatment => ({profile, ...treatment})),
);
const runs = balancedRuns(cases, stage.repetitions).slice(0, limit);
const images = Object.fromEntries(
  [...new Set(runs.map(runConfig => runConfig.worktree))].map(worktree => [
    worktree,
    `zero-copy-pipeline-${worktree}:local`,
  ]),
);
const manifest = {
  stage: stageName,
  generatedAt: new Date().toISOString(),
  execute,
  platform: 'linux/arm64',
  images,
  imageIDs: {},
  runs: runs.map(runConfig => ({
    ...runConfig,
    constraints: profiles[runConfig.profile].docker,
  })),
};
await mkdir(join(root, 'manifests'), {recursive: true});
await writeFile(
  join(root, 'manifests', `${stageName}-docker.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${stageName}: ${runs.length} ARM64 containers`,
);
for (const [index, runConfig] of runs.entries()) {
  console.log(
    `[${index + 1}/${runs.length}] ${runID(runConfig)} ${JSON.stringify(profiles[runConfig.profile].docker)}`,
  );
}
if (!execute) {
  process.exit(0);
}

run(process.execPath, [join(root, 'scripts/install-harness.mjs')]);
for (const [worktree, image] of Object.entries(images)) {
  const context = join(
    worktreeConfig.benchmarkRoot,
    worktreeConfig.worktrees[worktree].path,
  );
  run('docker', [
    'build',
    '--platform',
    'linux/arm64',
    '--file',
    join(root, 'Dockerfile.linux'),
    '--tag',
    image,
    context,
  ]);
  manifest.imageIDs[worktree] = capture('docker', [
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    image,
  ]).trim();
}
await writeFile(
  join(root, 'manifests', `${stageName}-docker.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const suffix = `${process.pid}-${Date.now()}`;
const network = `zero-copy-pipeline-${suffix}`;
const postgres = `zero-copy-pipeline-postgres-${suffix}`;
run('docker', ['network', 'create', network]);
run('docker', [
  'run',
  '--detach',
  '--name',
  postgres,
  '--network',
  network,
  '--network-alias',
  'postgres',
  '--memory',
  '2g',
  '--cpus',
  '2',
  '--env',
  'POSTGRES_PASSWORD=postgres',
  'postgres:17-alpine',
  '-c',
  'wal_level=logical',
  '-c',
  'max_replication_slots=100',
  '-c',
  'max_wal_senders=100',
]);

try {
  waitForPostgres(postgres);
  for (let index = 0; index < runs.length; index++) {
    const runConfig = runs[index];
    const fixture = profiles[runConfig.profile];
    const constraints = fixture.docker;
    const id = runID(runConfig);
    const output = join(
      root,
      'raw',
      `${stageName}-docker`,
      `${String(index + 1).padStart(3, '0')}-${id}.log`,
    );
    const env = {
      ZERO_COPY_PIPELINE_PROFILE: runConfig.profile,
      ZERO_COPY_PIPELINE_RUN_LABEL: id,
      ZERO_COPY_PIPELINE_FIXTURE: fixture.fixture,
      ZERO_COPY_PIPELINE_ROWS: String(fixture.rows),
      ZERO_COPY_PIPELINE_PAYLOAD_BYTES: String(fixture.payloadBytes),
      ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES: String(fixture.copyChunkBytes),
      ...(fixture.expectedCopyBytes === undefined
        ? {}
        : {
            ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES: String(
              fixture.expectedCopyBytes,
            ),
          }),
      ZERO_COPY_PIPELINE_MODE: 'sync',
      ZERO_COPY_PIPELINE_WORKERS: '5',
      ZERO_COPY_PIPELINE_PARTIAL_BATCHES: runConfig.partialInsertBatches
        ? '1'
        : '0',
      ZERO_COPY_PIPELINE_DIRECT_TEXT_BUFFERS: runConfig.directTextBuffers
        ? '1'
        : '0',
      ZERO_COPY_PIPELINE_EAGER_INDEXES: runConfig.eagerIndexes ? '1' : '0',
      ZERO_COPY_PIPELINE_EAGER_SECONDARY_INDEXES:
        runConfig.eagerSecondaryIndexes ? '1' : '0',
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
      ZERO_COPY_PIPELINE_MMAP_GIB: String(runConfig.mmapGiB ?? 1),
      ...(runConfig.cacheMB === undefined
        ? {}
        : {ZERO_COPY_PIPELINE_SQLITE_CACHE_MB: String(runConfig.cacheMB)}),
      ZERO_COPY_PIPELINE_INSTRUMENT: '1',
    };
    const dockerArgs = [
      'run',
      '--rm',
      '--init',
      '--network',
      network,
      '--platform',
      'linux/arm64',
      '--memory',
      constraints.memory,
      '--memory-swap',
      constraints.memory,
      '--cpus',
      String(constraints.cpus),
      '--pids-limit',
      '1024',
      '--env',
      'TEST_PG_17=postgres://postgres:postgres@postgres:5432/postgres',
      '--env',
      `NODE_OPTIONS=--max-old-space-size=${constraints.nodeHeapMB}`,
      ...Object.entries(env).flatMap(([name, value]) => [
        '--env',
        `${name}=${value}`,
      ]),
      images[runConfig.worktree],
      'bash',
      '-lc',
      linuxCommand(),
    ];
    console.log(`[${index + 1}/${runs.length}] ${id}`);
    await mkdir(dirname(output), {recursive: true});
    const startedAt = new Date().toISOString();
    const result = spawnSync('docker', dockerArgs, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    await writeFile(
      output,
      [
        `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify({startedAt, id, runConfig, fixture, constraints, image: images[runConfig.worktree], imageID: manifest.imageIDs[runConfig.worktree]})}`,
        result.stdout ?? '',
        result.stderr ?? '',
        `ZERO_COPY_PIPELINE_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
      ].join('\n'),
    );
    if (result.status !== 0) {
      throw new Error(`Docker run failed: ${output}`);
    }
  }
} finally {
  spawnSync('docker', ['rm', '--force', postgres], {encoding: 'utf8'});
  spawnSync('docker', ['network', 'rm', network], {encoding: 'utf8'});
}

function linuxCommand() {
  const cgroupScript = String.raw`
    const fs = require('node:fs');
    const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
    const pairs = value => Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [key, number] = line.split(/\s+/);
      return [key, Number(number)];
    }));
    const pressure = value => Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [kind, ...fields] = line.split(/\s+/);
      return [kind, Object.fromEntries(fields.map(field => {
        const [key, number] = field.split('=');
        return [key, Number(number)];
      }))];
    }));
    console.log('ZERO_COPY_PIPELINE_CGROUP ' + JSON.stringify({
      memoryPeakBytes: Number(read('memory.peak')),
      memoryCurrentBytes: Number(read('memory.current')),
      memoryMax: read('memory.max'),
      memoryEvents: pairs(read('memory.events')),
      memoryStat: pairs(read('memory.stat')),
      memoryPressure: pressure(read('memory.pressure')),
      ioPressure: pressure(read('io.pressure')),
      ioStat: read('io.stat'),
    }));
  `;
  return [
    'status=0',
    '/usr/bin/time -v ./node_modules/.bin/vitest run --config vitest.config.bench.pg.ts -t "initial sync copy pipeline investigation" || status=$?',
    `node --input-type=commonjs -e ${shellQuote(cgroupScript)}`,
    'exit $status',
  ].join('; ');
}

function runID(runConfig) {
  return `${slug(runConfig.profile)}-${slug(runConfig.label)}-r${runConfig.repetition}`;
}

function balancedRuns(casesToRun, repetitions) {
  const output = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const offset = (repetition - 1) % casesToRun.length;
    const rotated = casesToRun
      .slice(offset)
      .concat(casesToRun.slice(0, offset));
    const ordered = repetition % 2 === 1 ? rotated : [...rotated].reverse();
    for (const runConfig of ordered) {
      output.push({...runConfig, repetition});
    }
  }
  return output;
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'postgres'],
      {
        encoding: 'utf8',
      },
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

function capture(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-');
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}
