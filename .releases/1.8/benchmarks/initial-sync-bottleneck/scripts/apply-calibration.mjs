import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const profilePath = join(root, 'config/profiles.json');
const resultsPath = join(root, 'results/calibration.json');
const [profiles, results] = await Promise.all([
  readJSON(profilePath),
  readJSON(resultsPath),
]);

if (results.failedRuns !== 0) {
  throw new Error(
    `Calibration has ${results.failedRuns} failed runs; inspect ${resultsPath}`,
  );
}

const seen = new Set();
for (const run of results.runs) {
  if (run.kind !== 'fixture-validation') {
    continue;
  }
  const profile = profiles[run.profileName];
  if (!profile) {
    throw new Error(
      `Unknown profile in calibration output: ${run.profileName}`,
    );
  }
  if (seen.has(run.profileName)) {
    throw new Error(`Duplicate calibration result for ${run.profileName}`);
  }
  seen.add(run.profileName);
  profile.binaryCopyBytes = run.copy.binary.bytes;
  profile.textCopyBytes = run.copy.text.bytes;
  const ratio = profile.targetBinaryCopyBytes / profile.binaryCopyBytes;
  const errorPercent = Math.abs(1 - ratio) * 100;
  const suggestedRows = Math.round(profile.totalRows * ratio);
  const status =
    errorPercent <= 1.25 ? 'ready' : `rerun with totalRows=${suggestedRows}`;
  console.log(
    `${run.profileName}: ${profile.binaryCopyBytes} binary bytes ` +
      `(${errorPercent.toFixed(2)}% from target), ${status}`,
  );
}

if (seen.size === 0) {
  throw new Error(`No fixture-validation results found in ${resultsPath}`);
}

await writeFile(profilePath, `${JSON.stringify(profiles, null, 2)}\n`);
console.log(`updated ${profilePath}`);

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
