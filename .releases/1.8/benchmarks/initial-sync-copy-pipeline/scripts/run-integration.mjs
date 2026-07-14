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
    'Usage: node scripts/run-integration.mjs <stage> [--execute] [--limit=N]',
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
const manifest = {
  stage: stageName,
  generatedAt: new Date().toISOString(),
  execute,
  runs,
};
await mkdir(join(root, 'manifests'), {recursive: true});
await writeFile(
  join(root, 'manifests', `${stageName}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${stageName}: ${runs.length} processes`,
);
if (!execute) {
  for (const [index, runConfig] of runs.entries()) {
    console.log(`[${index + 1}/${runs.length}] ${runID(runConfig)}`);
  }
  process.exit(0);
}

run(process.execPath, [join(root, 'scripts/install-harness.mjs')]);
const postgres = `zero-copy-pipeline-postgres-${process.pid}-${Date.now()}`;
run('docker', [
  'run',
  '--detach',
  '--name',
  postgres,
  '--publish',
  '127.0.0.1::5432',
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
  const portOutput = commandOutput('docker', [
    'port',
    postgres,
    '5432/tcp',
  ]).trim();
  const port = portOutput.slice(portOutput.lastIndexOf(':') + 1);
  const pgURI = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

  for (let index = 0; index < runs.length; index++) {
    const runConfig = runs[index];
    const fixture = profiles[runConfig.profile];
    const worktree = worktreeConfig.worktrees[runConfig.worktree];
    const cwd = join(
      worktreeConfig.benchmarkRoot,
      worktree.path,
      'packages/zero-cache',
    );
    const id = runID(runConfig);
    const output = join(
      root,
      'raw',
      stageName,
      `${String(index + 1).padStart(3, '0')}-${id}.log`,
    );
    const env = {
      ...process.env,
      TEST_PG_17: pgURI,
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
      ZERO_COPY_PIPELINE_BUFFER_MB: String(runConfig.bufferMB),
      ZERO_COPY_PIPELINE_MMAP_GIB: String(runConfig.mmapGiB ?? 1),
      ...(runConfig.cacheMB === undefined
        ? {}
        : {ZERO_COPY_PIPELINE_SQLITE_CACHE_MB: String(runConfig.cacheMB)}),
      ZERO_COPY_PIPELINE_INSTRUMENT: '1',
    };
    const command = [
      './node_modules/.bin/vitest',
      'run',
      '--config',
      'vitest.config.bench.pg.ts',
      '-t',
      'initial sync copy pipeline investigation',
    ];
    console.log(`[${index + 1}/${runs.length}] ${id}`);
    await mkdir(dirname(output), {recursive: true});
    const startedAt = new Date().toISOString();
    const result = spawnSync(command[0], command.slice(1), {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    await writeFile(
      output,
      [
        `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify({startedAt, id, runConfig, fixture, cwd})}`,
        result.stdout ?? '',
        result.stderr ?? '',
        `ZERO_COPY_PIPELINE_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
      ].join('\n'),
    );
    if (result.status !== 0) {
      throw new Error(`Run failed: ${output}`);
    }
  }
} finally {
  spawnSync('docker', ['rm', '--force', postgres], {encoding: 'utf8'});
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

function commandOutput(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', stdio: 'inherit'});
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-');
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}
