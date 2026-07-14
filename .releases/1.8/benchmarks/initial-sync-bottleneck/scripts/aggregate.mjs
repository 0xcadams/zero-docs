import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stage = process.argv[2];
if (!stage) {
  throw new Error('Usage: node scripts/aggregate.mjs <stage>');
}

const rawDirectory = join(root, 'raw', stage);
const files = (await readdir(rawDirectory))
  .filter(file => file.endsWith('.log'))
  .sort();
const runs = [];
const failures = [];

for (const file of files) {
  const text = await readFile(join(rawDirectory, file), 'utf8');
  const resultLine = text
    .split(/\r?\n/)
    .find(line => line.includes('ZERO_INITIAL_SYNC_RESULT '));
  const exitLine = text
    .split(/\r?\n/)
    .find(line => line.startsWith('ZERO_INITIAL_SYNC_EXIT '));
  const cgroupLine = text
    .split(/\r?\n/)
    .find(line => line.startsWith('ZERO_INITIAL_SYNC_CGROUP '));
  if (!resultLine) {
    failures.push({file, reason: 'missing ZERO_INITIAL_SYNC_RESULT', exitLine});
    continue;
  }
  const json = resultLine.slice(
    resultLine.indexOf('ZERO_INITIAL_SYNC_RESULT ') + 25,
  );
  try {
    const cgroup = cgroupLine
      ? JSON.parse(cgroupLine.slice('ZERO_INITIAL_SYNC_CGROUP '.length))
      : undefined;
    runs.push({file, ...JSON.parse(json), ...(cgroup ? {cgroup} : {})});
  } catch (error) {
    failures.push({
      file,
      reason: `invalid result JSON: ${error.message}`,
      resultLine,
    });
  }
}

const output = {
  stage,
  generatedAt: new Date().toISOString(),
  files: files.length,
  successfulRuns: runs.length,
  failedRuns: failures.length,
  failures,
  runs,
};
await mkdir(join(root, 'results'), {recursive: true});
const outputPath = join(root, 'results', `${stage}.json`);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `${runs.length} successful runs, ${failures.length} failures -> ${outputPath}`,
);
