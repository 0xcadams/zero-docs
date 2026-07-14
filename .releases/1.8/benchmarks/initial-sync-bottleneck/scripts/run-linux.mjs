import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stageName = process.argv[2];
const execute = process.argv.includes('--execute');
const startArgument = process.argv.find(arg => arg.startsWith('--start='));
const limitArgument = process.argv.find(arg => arg.startsWith('--limit='));
const start = startArgument
  ? Number(startArgument.slice('--start='.length))
  : 1;
const limit = limitArgument
  ? Number(limitArgument.slice('--limit='.length))
  : Infinity;

if (!stageName || stageName.startsWith('--')) {
  throw new Error(
    'Usage: node scripts/run-linux.mjs <stage> [--execute] [--start=N] [--limit=N]',
  );
}
if (!Number.isInteger(start) || start < 1) {
  throw new Error('--start must be a positive integer');
}
if ((!Number.isInteger(limit) || limit < 1) && limit !== Infinity) {
  throw new Error('--limit must be a positive integer');
}

const [worktreeConfig, profiles, stages] = await Promise.all([
  readJSON('config/worktrees.json'),
  readJSON('config/profiles.json'),
  readJSON('config/stages.json'),
]);
const stage = stages[stageName];
if (!stage) {
  throw new Error(
    `Unknown stage ${stageName}; choose one of ${Object.keys(stages).join(', ')}`,
  );
}

const cases = expandCases(stageName, stage, profiles, worktreeConfig.worktrees);
const worktreeNames = new Set(cases.map(run => run.worktree));
if (worktreeNames.size !== 1) {
  throw new Error(
    'The Linux runner requires every treatment to use one worktree',
  );
}
const [worktreeName] = worktreeNames;
const worktree = worktreeConfig.worktrees[worktreeName];
if (worktree.copyFormat !== 'binary') {
  throw new Error('The Linux mmap sweep requires the Zero 1.8 binary worktree');
}

const allRuns = balancedRuns(cases, stage.repetitions);
const orderedRuns = allRuns.slice(start - 1).slice(0, limit);
const constraints = {
  platform: 'linux/arm64',
  memory: '3g',
  memorySwap: '3g',
  cpus: '1',
  nodeOptions: '--max-old-space-size=2304',
};
const image = `zero-initial-sync-linux:${worktree.commit.slice(0, 12)}`;
const worktreeRoot = join(worktreeConfig.benchmarkRoot, worktree.path);
const manifest = {
  stage: stageName,
  generatedAt: new Date().toISOString(),
  execute,
  start,
  repetitions: stage.repetitions,
  image,
  constraints,
  runs: orderedRuns.map((run, index) => ({index: start + index, ...run})),
};
await mkdir(join(root, 'manifests'), {recursive: true});
const manifestPath = join(
  root,
  'manifests',
  `${stageName}${start > 1 ? `-from-${start}` : ''}.json`,
);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${stageName}: ${orderedRuns.length} sequential Linux containers`,
);
console.log(`manifest: ${manifestPath}`);
console.log(
  `constraints: ${constraints.platform}, ${constraints.memory} memory, ${constraints.cpus} CPU, no swap, ${constraints.nodeOptions}`,
);

for (let index = 0; index < orderedRuns.length; index++) {
  const run = orderedRuns[index];
  const runNumber = start + index;
  console.log(`[${runNumber}/${allRuns.length}] ${run.id}`);
}

if (!execute) {
  console.log(
    'No image, database, fixture, or benchmark process was started. Add --execute only when ready.',
  );
  process.exit(0);
}

run(process.execPath, [join(root, 'scripts/install-harness.mjs')]);
run('docker', [
  'build',
  '--platform',
  constraints.platform,
  '--file',
  join(root, 'Dockerfile.linux'),
  '--tag',
  image,
  worktreeRoot,
]);

const suffix = `${process.pid}-${Date.now()}`;
const network = `zero-initial-sync-${suffix}`;
const postgres = `zero-initial-sync-postgres-${suffix}`;
run('docker', ['network', 'create', network]);

try {
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
    '-c',
    'timezone=UTC+1',
  ]);
  waitForPostgres(postgres);

  for (let index = 0; index < orderedRuns.length; index++) {
    const runConfig = orderedRuns[index];
    const runNumber = start + index;
    const rawDirectory = join(root, 'raw', stageName);
    const outputPath = join(
      rawDirectory,
      `${String(runNumber).padStart(3, '0')}-${runConfig.id}.log`,
    );
    const env = benchmarkEnv(runConfig, worktree);
    const dockerArgs = [
      'run',
      '--rm',
      '--init',
      '--network',
      network,
      '--platform',
      constraints.platform,
      '--memory',
      constraints.memory,
      '--memory-swap',
      constraints.memorySwap,
      '--cpus',
      constraints.cpus,
      '--pids-limit',
      '1024',
      '--env',
      'TEST_PG_17=postgres://postgres:postgres@postgres:5432/postgres',
      '--env',
      `NODE_OPTIONS=${constraints.nodeOptions}`,
      ...Object.entries(env).flatMap(([name, value]) => [
        '--env',
        `${name}=${value}`,
      ]),
      image,
      'bash',
      '-lc',
      linuxCommand(),
    ];
    console.log(
      `[${runNumber}/${allRuns.length}] ${runConfig.id}\n` +
        `  out: ${outputPath}`,
    );
    await mkdir(rawDirectory, {recursive: true});
    const startedAt = new Date().toISOString();
    const result = spawnSync('docker', dockerArgs, {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    });
    const log = [
      `ZERO_INITIAL_SYNC_RUN_META ${JSON.stringify({startedAt, run: runConfig, constraints, image})}`,
      result.stdout ?? '',
      result.stderr ?? '',
      `ZERO_INITIAL_SYNC_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
    ].join('\n');
    await writeFile(outputPath, log);
    if (result.status !== 0) {
      throw new Error(
        `Run failed with status ${result.status}; see ${outputPath}`,
      );
    }
  }
} finally {
  spawnSync('docker', ['rm', '--force', postgres], {encoding: 'utf8'});
  spawnSync('docker', ['network', 'rm', network], {encoding: 'utf8'});
}

function benchmarkEnv(runConfig, worktreeConfig) {
  return {
    ZERO_INITIAL_SYNC_MODE: runConfig.mode,
    ZERO_INITIAL_SYNC_PROFILE: runConfig.profile,
    ZERO_INITIAL_SYNC_TOTAL_ROWS: String(runConfig.totalRows),
    ZERO_INITIAL_SYNC_COPY_FORMAT: worktreeConfig.copyFormat,
    ZERO_INITIAL_SYNC_WORKERS: String(runConfig.workers),
    ZERO_INITIAL_SYNC_INDEX_PROFILE: runConfig.indexProfile,
    ZERO_INITIAL_SYNC_INSTRUMENT: runConfig.instrument ? '1' : '0',
    ZERO_INITIAL_SYNC_RUN_LABEL: runConfig.id,
    ...(runConfig.sqliteMmapMB === undefined
      ? {}
      : {ZERO_INITIAL_SYNC_SQLITE_MMAP_MB: String(runConfig.sqliteMmapMB)}),
    ...(runConfig.binaryCopyBytes === null
      ? {}
      : {
          ZERO_INITIAL_SYNC_BINARY_COPY_BYTES: String(
            runConfig.binaryCopyBytes,
          ),
        }),
    ...(runConfig.textCopyBytes === null
      ? {}
      : {ZERO_INITIAL_SYNC_TEXT_COPY_BYTES: String(runConfig.textCopyBytes)}),
  };
}

function linuxCommand() {
  const cgroupScript = String.raw`
    const fs = require('node:fs');
    const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
    const pairs = value => Object.fromEntries(value.split(/\n/).filter(Boolean).map(line => {
      const [key, number] = line.split(/\s+/);
      return [key, Number(number)];
    }));
    console.log('ZERO_INITIAL_SYNC_CGROUP ' + JSON.stringify({
      memoryPeakBytes: Number(read('memory.peak')),
      memoryCurrentBytes: Number(read('memory.current')),
      memoryMax: read('memory.max'),
      memoryEvents: pairs(read('memory.events')),
      memoryStat: pairs(read('memory.stat')),
    }));
  `;
  return [
    'status=0',
    '/usr/bin/time -v ./node_modules/.bin/vitest run --config vitest.config.product.pg.ts -t "initial sync bottleneck investigation" || status=$?',
    `node --input-type=commonjs -e ${shellQuote(cgroupScript)}`,
    'exit $status',
  ].join('; ');
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = spawnSync(
      'docker',
      ['exec', container, 'pg_isready', '--username', 'postgres'],
      {encoding: 'utf8'},
    );
    if (result.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('Postgres did not become ready within 30 seconds');
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function expandCases(stageLabel, stageConfig, profileConfig, worktrees) {
  const entries = [...stageConfig.treatments, ...(stageConfig.controls ?? [])];
  const expanded = [];
  for (const treatment of entries) {
    if (!worktrees[treatment.worktree]) {
      throw new Error(
        `Unknown worktree ${treatment.worktree} in ${stageLabel}`,
      );
    }
    const selectedProfiles = treatment.profiles ?? stageConfig.profiles;
    for (const profile of selectedProfiles) {
      const fixture = profileConfig[profile];
      if (!fixture) {
        throw new Error(`Unknown fixture profile ${profile} in ${stageLabel}`);
      }
      const instrument = Boolean(treatment.instrument);
      const id = slug(
        [
          stageLabel,
          profile,
          treatment.worktree,
          treatment.mode ?? stageConfig.mode,
          `w${treatment.workers}`,
          treatment.indexProfile,
          treatment.tuningLabel,
          instrument ? 'instrumented' : 'plain',
        ].join('-'),
      );
      expanded.push({
        id,
        profile,
        totalRows: fixture.totalRows,
        binaryCopyBytes: fixture.binaryCopyBytes,
        textCopyBytes: fixture.textCopyBytes,
        worktree: treatment.worktree,
        mode: treatment.mode ?? stageConfig.mode,
        workers: treatment.workers,
        indexProfile: treatment.indexProfile,
        instrument,
        tuningLabel: treatment.tuningLabel,
        sqliteMmapMB: treatment.sqliteMmapMB,
      });
    }
  }
  return expanded;
}

function balancedRuns(casesToRun, repetitions) {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const offset = repetition % casesToRun.length;
    const rotated = casesToRun
      .slice(offset)
      .concat(casesToRun.slice(0, offset));
    const ordered = repetition % 2 === 0 ? rotated : [...rotated].reverse();
    for (const runConfig of ordered) {
      runs.push({
        ...runConfig,
        repetition: repetition + 1,
        id: `${runConfig.id}-r${repetition + 1}`,
      });
    }
  }
  return runs;
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
