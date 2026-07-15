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
    'Usage: node scripts/run-parser.mjs <stage> [--execute] [--limit=N]',
  );
}

const [worktreeConfig, profiles, stages] = await Promise.all([
  readJSON('config/worktrees.json'),
  readJSON('config/profiles.json'),
  readJSON('config/stages.json'),
]);
const stage = stages[stageName];
if (!stage) {
  throw new Error(`Unknown stage ${stageName}`);
}
const cases = stage.profiles.flatMap(profile =>
  stage.worktrees.map(worktree => ({profile, worktree})),
);
const allRuns = balancedRuns(cases, stage.repetitions).slice(0, limit);
const manifest = {
  stage: stageName,
  generatedAt: new Date().toISOString(),
  execute,
  runs: allRuns,
};
await mkdir(join(root, 'manifests'), {recursive: true});
await writeFile(
  join(root, 'manifests', `${stageName}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `${execute ? 'EXECUTE' : 'DRY RUN'} ${stageName}: ${allRuns.length} processes`,
);
if (execute) {
  run(process.execPath, [
    join(root, 'scripts/install-harness.mjs'),
    ...new Set(allRuns.map(runConfig => runConfig.worktree)),
  ]);
}

for (let index = 0; index < allRuns.length; index++) {
  const runConfig = allRuns[index];
  const profile = profiles[runConfig.profile];
  const worktree = worktreeConfig.worktrees[runConfig.worktree];
  const cwd = join(
    worktreeConfig.benchmarkRoot,
    worktree.path,
    'packages/zero-cache',
  );
  const id = `${slug(runConfig.profile)}-${slug(runConfig.worktree)}-r${runConfig.repetition}`;
  const output = join(
    root,
    'raw',
    stageName,
    `${String(index + 1).padStart(3, '0')}-${id}.log`,
  );
  const env = {
    ...process.env,
    ZERO_COPY_PIPELINE_PROFILE: runConfig.profile,
    ZERO_COPY_PIPELINE_RUN_LABEL: id,
    ZERO_COPY_PIPELINE_FIELD_BYTES: String(profile.fieldBytes),
    ZERO_COPY_PIPELINE_CHUNK_BYTES: String(profile.chunkBytes),
    ZERO_COPY_PIPELINE_COLUMNS: String(profile.columns),
    ZERO_COPY_PIPELINE_ROWS: String(profile.rows),
    ZERO_COPY_PIPELINE_WARMUPS: String(profile.warmups),
    ZERO_COPY_PIPELINE_ITERATIONS: String(profile.iterations),
  };
  const command = [
    './node_modules/.bin/vitest',
    'run',
    '--config',
    'vitest.config.bench.ts',
    '-t',
    'initial sync copy parser investigation',
  ];
  console.log(`[${index + 1}/${allRuns.length}] ${id}`);
  if (!execute) {
    continue;
  }
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
      `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify({startedAt, id, runConfig, profile, cwd})}`,
      result.stdout ?? '',
      result.stderr ?? '',
      `ZERO_COPY_PIPELINE_EXIT ${JSON.stringify({status: result.status, signal: result.signal, error: result.error?.message})}`,
    ].join('\n'),
  );
  if (result.status !== 0) {
    throw new Error(`Run failed: ${output}`);
  }
}

function balancedRuns(casesToRun, repetitions) {
  const runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const offset = (repetition - 1) % casesToRun.length;
    const rotated = casesToRun
      .slice(offset)
      .concat(casesToRun.slice(0, offset));
    const ordered = repetition % 2 === 1 ? rotated : [...rotated].reverse();
    for (const runConfig of ordered) {
      runs.push({...runConfig, repetition});
    }
  }
  return runs;
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
