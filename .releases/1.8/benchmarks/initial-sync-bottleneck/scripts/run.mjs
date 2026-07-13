import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stageName = process.argv[2];
const execute = process.argv.includes('--execute');
const allowUncalibrated = process.argv.includes('--allow-uncalibrated');
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
    'Usage: node scripts/run.mjs <stage> [--execute] [--allow-uncalibrated] [--start=N] [--limit=N]',
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

if (execute && stageName !== 'calibration' && !allowUncalibrated) {
  const stageEntries = [...stage.treatments, ...(stage.controls ?? [])];
  const requiresTextBytes = stageEntries.some(
    treatment =>
      worktreeConfig.worktrees[treatment.worktree].copyFormat === 'text',
  );
  const uncalibrated = stage.profiles.filter(profile => {
    const fixture = profiles[profile];
    if (!fixture || fixture.binaryCopyBytes === null) {
      return true;
    }
    return (
      Math.abs(fixture.binaryCopyBytes - fixture.targetBinaryCopyBytes) /
        fixture.targetBinaryCopyBytes >
        0.0125 ||
      (requiresTextBytes && fixture.textCopyBytes === null)
    );
  });
  if (uncalibrated.length) {
    throw new Error(
      `Refusing uncalibrated execution. Missing or out-of-range binary COPY bytes for ${uncalibrated.join(', ')}. ` +
        'Run calibration first or explicitly pass --allow-uncalibrated.',
    );
  }
}

const cases = expandCases(stageName, stage, profiles, worktreeConfig.worktrees);
const allRuns = balancedRuns(cases, stage.repetitions);
const orderedRuns = allRuns.slice(start - 1).slice(0, limit);
const manifest = {
  stage: stageName,
  generatedAt: new Date().toISOString(),
  execute,
  start,
  repetitions: stage.repetitions,
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
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${stageName}: ${orderedRuns.length} sequential processes`,
);
console.log(`manifest: ${manifestPath}`);

for (let index = 0; index < orderedRuns.length; index++) {
  const run = orderedRuns[index];
  const runNumber = start + index;
  const worktree = worktreeConfig.worktrees[run.worktree];
  const cwd = join(
    worktreeConfig.benchmarkRoot,
    worktree.path,
    'packages/zero-cache',
  );
  const rawDirectory = join(root, 'raw', stageName);
  const outputPath = join(
    rawDirectory,
    `${String(runNumber).padStart(3, '0')}-${run.id}.log`,
  );
  const env = {
    ...process.env,
    ZERO_INITIAL_SYNC_MODE: run.mode,
    ZERO_INITIAL_SYNC_PROFILE: run.profile,
    ZERO_INITIAL_SYNC_TOTAL_ROWS: String(run.totalRows),
    ZERO_INITIAL_SYNC_COPY_FORMAT: worktree.copyFormat,
    ZERO_INITIAL_SYNC_WORKERS: String(run.workers),
    ZERO_INITIAL_SYNC_INDEX_PROFILE: run.indexProfile,
    ZERO_INITIAL_SYNC_INSTRUMENT: run.instrument ? '1' : '0',
    ZERO_INITIAL_SYNC_RUN_LABEL: run.id,
    ...(run.sqliteCacheMB === undefined
      ? {}
      : {ZERO_INITIAL_SYNC_SQLITE_CACHE_MB: String(run.sqliteCacheMB)}),
    ...(run.sqliteMmapMB === undefined
      ? {}
      : {ZERO_INITIAL_SYNC_SQLITE_MMAP_MB: String(run.sqliteMmapMB)}),
    ...(run.sqliteTempStore === undefined
      ? {}
      : {ZERO_INITIAL_SYNC_SQLITE_TEMP_STORE: run.sqliteTempStore}),
    ...(run.binaryCopyBytes === null
      ? {}
      : {ZERO_INITIAL_SYNC_BINARY_COPY_BYTES: String(run.binaryCopyBytes)}),
    ...(run.textCopyBytes === null
      ? {}
      : {ZERO_INITIAL_SYNC_TEXT_COPY_BYTES: String(run.textCopyBytes)}),
  };
  const command = [
    '/usr/bin/time',
    '-lp',
    worktree.vitestPath,
    'run',
    '--config',
    'vitest.config.product.pg.ts',
    '-t',
    'initial sync bottleneck investigation',
  ];
  console.log(
    `[${runNumber}/${allRuns.length}] ${run.id}\n` +
      `  cwd: ${cwd}\n` +
      `  out: ${outputPath}\n` +
      `  cmd: ${formatEnv(env)} ${command.map(shellQuote).join(' ')}`,
  );
  if (!execute) {
    continue;
  }
  await mkdir(rawDirectory, {recursive: true});
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  const log = [
    `ZERO_INITIAL_SYNC_RUN_META ${JSON.stringify({startedAt, run, command, cwd})}`,
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

if (!execute) {
  console.log(
    'No fixture or benchmark process was started. Add --execute only when ready.',
  );
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
      const mode = treatment.mode ?? stageConfig.mode;
      const instrument = Boolean(treatment.instrument);
      const id = slug(
        [
          stageLabel,
          profile,
          treatment.worktree,
          mode,
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
        targetBinaryCopyBytes: fixture.targetBinaryCopyBytes,
        binaryCopyBytes: fixture.binaryCopyBytes,
        textCopyBytes: fixture.textCopyBytes,
        worktree: treatment.worktree,
        mode,
        workers: treatment.workers,
        indexProfile: treatment.indexProfile,
        instrument,
        tuningLabel: treatment.tuningLabel,
        sqliteCacheMB: treatment.sqliteCacheMB,
        sqliteMmapMB: treatment.sqliteMmapMB,
        sqliteTempStore: treatment.sqliteTempStore,
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
    for (const run of ordered) {
      runs.push({
        ...run,
        repetition: repetition + 1,
        id: `${run.id}-r${repetition + 1}`,
      });
    }
  }
  return runs;
}

function formatEnv(env) {
  const names = Object.keys(env)
    .filter(name => name.startsWith('ZERO_INITIAL_SYNC_'))
    .sort();
  return names.map(name => `${name}=${shellQuote(env[name])}`).join(' ');
}

function shellQuote(value) {
  const string = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(string)
    ? string
    : `'${string.replaceAll("'", "'\\''")}'`;
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-');
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}
