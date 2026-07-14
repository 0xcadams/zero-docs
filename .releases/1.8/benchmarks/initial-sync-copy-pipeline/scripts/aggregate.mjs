import {readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2];
if (!stage) {
  throw new Error('Usage: node scripts/aggregate.mjs <stage>');
}
const directory = join(root, 'raw', stage);
const files = (await readdir(directory))
  .filter(file => file.endsWith('.log'))
  .sort();
const runs = [];
for (const file of files) {
  const text = await readFile(join(directory, file), 'utf8');
  const meta = parseLine(text, 'ZERO_COPY_PIPELINE_RUN_META ');
  const result = parseLine(text, 'ZERO_COPY_PIPELINE_RESULT ');
  const exit = parseLine(text, 'ZERO_COPY_PIPELINE_EXIT ');
  if (!meta || !result || !exit || exit.status !== 0) {
    throw new Error(`Invalid run protocol in ${file}`);
  }
  const cgroup = parseLine(text, 'ZERO_COPY_PIPELINE_CGROUP ');
  runs.push({file, meta, result, exit, ...(cgroup ? {cgroup} : {})});
}

const groups = new Map();
for (const run of runs) {
  const key = `${run.meta.runConfig.profile}/${run.meta.runConfig.label ?? run.meta.runConfig.worktree}`;
  const samples = run.result.samples
    ? run.result.samples.map(sample => sample.wallMs)
    : [run.result.timing.callbackMs];
  const entry = groups.get(key) ?? [];
  entry.push(...samples);
  groups.set(key, entry);
}
const summary = Object.fromEntries(
  [...groups].map(([key, values]) => [key, summarize(values)]),
);
const output = {stage, generatedAt: new Date().toISOString(), runs, summary};
await writeFile(
  join(root, 'results', `${stage}.json`),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function parseLine(text, prefix) {
  const line = text.split('\n').find(candidate => candidate.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : undefined;
}

function summarize(input) {
  const values = [...input].sort((a, b) => a - b);
  return {
    n: values.length,
    minMs: values[0],
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.at(-1),
  };
}

function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return values[lower];
  }
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}
