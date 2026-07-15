import {createHash} from 'node:crypto';
import {lstat, readdir, readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';

import {runID} from './analysis.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const RUN_TOKEN = /^[a-zA-Z0-9._-]+$/;

export async function loadArtifactSet({
  root,
  stage,
  runToken,
  forceLegacy = false,
}) {
  const stageDirectory = join(root, 'raw', stage);
  if (runToken !== undefined) {
    validateRunToken(runToken);
    if (forceLegacy) {
      throw new Error('A run token cannot be used with legacy artifact mode');
    }
    return loadNestedArtifactSet(root, stage, runToken);
  }

  if (!forceLegacy) {
    const entries = await readdir(stageDirectory, {withFileTypes: true});
    const nestedRuns = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    if (nestedRuns.length > 1) {
      throw new Error(
        `Multiple immutable runs exist for ${stage}; specify an exact run token: ${nestedRuns.join(', ')}`,
      );
    }
    if (nestedRuns.length === 1) {
      return loadNestedArtifactSet(root, stage, nestedRuns[0]);
    }
  }

  const manifestPath = join(root, 'manifests', `${stage}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = (await readdir(stageDirectory, {withFileTypes: true}))
    .filter(entry => entry.isFile() && entry.name.endsWith('.log'))
    .map(entry => entry.name)
    .sort();
  return {
    canonical: false,
    manifest,
    files: await Promise.all(
      files.map(async file => ({
        file,
        text: await readFile(join(stageDirectory, file), 'utf8'),
      })),
    ),
    source: {
      kind: 'legacy-flat',
      canonical: false,
      manifestPath: relative(root, manifestPath),
      runToken: null,
    },
  };
}

export function parseRunArtifacts(files) {
  return files.map(({artifact, file, text}) => {
    const meta = parseUniqueLine(text, 'ZERO_COPY_PIPELINE_RUN_META ', file);
    const result = parseUniqueLine(text, 'ZERO_COPY_PIPELINE_RESULT ', file);
    const exit = parseUniqueLine(text, 'ZERO_COPY_PIPELINE_EXIT ', file);
    if (!meta || !result || !exit || exit.status !== 0) {
      throw new Error(`Invalid run protocol in ${file}`);
    }
    if (artifact && meta.id !== artifact.runID) {
      throw new Error(
        `${file}: run metadata ${meta.id} does not match expected artifact ${artifact.runID}`,
      );
    }
    const cgroup = parseUniqueLine(text, 'ZERO_COPY_PIPELINE_CGROUP ', file);
    return {file, meta, result, exit, ...(cgroup ? {cgroup} : {})};
  });
}

async function loadNestedArtifactSet(root, stage, runToken) {
  validateRunToken(runToken);
  const runDirectory = join(root, 'raw', stage, runToken);
  const runDirectoryStat = await lstat(runDirectory);
  if (!runDirectoryStat.isDirectory() || runDirectoryStat.isSymbolicLink()) {
    throw new Error(`${runDirectory} is not an immutable run directory`);
  }
  const manifestPath = join(runDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const canonical = validateNestedManifest(manifest, stage, runToken);
  const expectedByPath = new Map();
  const expectedRunIDs = new Set();
  for (const artifact of manifest.expectedArtifacts) {
    validateExpectedArtifact(artifact);
    if (expectedByPath.has(artifact.path)) {
      throw new Error(`Manifest has duplicate artifact path ${artifact.path}`);
    }
    if (expectedRunIDs.has(artifact.runID)) {
      throw new Error(
        `Manifest has duplicate artifact runID ${artifact.runID}`,
      );
    }
    expectedByPath.set(artifact.path, artifact);
    expectedRunIDs.add(artifact.runID);
  }

  const rootEntries = await readdir(runDirectory, {withFileTypes: true});
  const invalidRootEntries = rootEntries.filter(
    entry =>
      !(
        (entry.name === 'manifest.json' && entry.isFile()) ||
        (entry.name === 'operations' && entry.isDirectory())
      ),
  );
  if (invalidRootEntries.length) {
    throw new Error(
      `Unexpected artifacts in immutable run: ${invalidRootEntries.map(entry => entry.name).join(', ')}`,
    );
  }
  if (
    !rootEntries.some(
      entry => entry.name === 'manifest.json' && entry.isFile(),
    ) ||
    !rootEntries.some(
      entry => entry.name === 'operations' && entry.isDirectory(),
    )
  ) {
    throw new Error('Immutable run must contain manifest.json and operations/');
  }

  const operationEntries = await readdir(join(runDirectory, 'operations'), {
    withFileTypes: true,
  });
  const actualPaths = operationEntries
    .filter(entry => entry.isFile())
    .map(entry => `operations/${entry.name}`)
    .sort();
  const nonFiles = operationEntries.filter(entry => !entry.isFile());
  if (nonFiles.length) {
    throw new Error(
      `Unexpected artifacts in operations/: ${nonFiles.map(entry => entry.name).join(', ')}`,
    );
  }
  const expectedPaths = [...expectedByPath.keys()].sort();
  const missing = expectedPaths.filter(path => !actualPaths.includes(path));
  const extra = actualPaths.filter(path => !expectedByPath.has(path));
  if (missing.length || extra.length) {
    throw new Error(
      [
        missing.length ? `missing artifacts: ${missing.join(', ')}` : undefined,
        extra.length ? `extra artifacts: ${extra.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }

  const files = [];
  for (const artifact of manifest.expectedArtifacts) {
    const data = await readFile(join(runDirectory, artifact.path));
    const actualSHA256 = createHash('sha256').update(data).digest('hex');
    if (actualSHA256 !== artifact.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${artifact.path}: expected ${artifact.sha256}, got ${actualSHA256}`,
      );
    }
    files.push({
      artifact,
      file: artifact.path,
      text: data.toString('utf8'),
    });
  }

  return {
    canonical,
    manifest,
    files,
    source: {
      kind: 'nested-immutable',
      canonical,
      manifestPath: relative(root, manifestPath),
      runToken,
    },
  };
}

function validateNestedManifest(manifest, stage, runToken) {
  const expectedStage = stage.endsWith('-docker')
    ? stage.slice(0, -'-docker'.length)
    : stage;
  if (manifest.schemaVersion !== 2) {
    throw new Error('Nested immutable manifest must have schemaVersion 2');
  }
  if (manifest.stage !== expectedStage) {
    throw new Error(
      `Manifest stage ${manifest.stage} does not match requested stage ${expectedStage}`,
    );
  }
  if (manifest.runToken !== runToken) {
    throw new Error(
      `Manifest run token ${manifest.runToken} does not match directory ${runToken}`,
    );
  }
  if (!['canonical', 'noncanonical'].includes(manifest.mode)) {
    throw new Error(`Nested manifest has invalid mode ${manifest.mode}`);
  }
  if (manifest.execute !== true || manifest.status !== 'complete') {
    throw new Error('Nested manifest execution status is incomplete');
  }
  if (manifest.mode === 'canonical') {
    if (
      manifest.evidence?.eligible !== true ||
      manifest.evidence?.classification !== 'canonical-complete' ||
      !Array.isArray(manifest.evidence?.reasons) ||
      manifest.evidence.reasons.length !== 0
    ) {
      throw new Error('Canonical manifest evidence is incomplete or ineligible');
    }
  } else if (
    manifest.evidence?.eligible !== false ||
    manifest.evidence?.classification !== 'noncanonical' ||
    !Array.isArray(manifest.evidence?.reasons) ||
    manifest.evidence.reasons.length === 0
  ) {
    throw new Error('Noncanonical manifest evidence is invalid');
  }
  if (
    !Number.isFinite(Date.parse(manifest.generatedAt)) ||
    !Number.isFinite(Date.parse(manifest.completedAt)) ||
    Date.parse(manifest.completedAt) < Date.parse(manifest.generatedAt)
  ) {
    throw new Error('Nested manifest has invalid execution timestamps');
  }
  if (
    !Array.isArray(manifest.runs) ||
    !Array.isArray(manifest.expectedArtifacts) ||
    !Array.isArray(manifest.operations) ||
    manifest.runs.length === 0 ||
    manifest.expectedArtifacts.length !== manifest.runs.length ||
    manifest.operations.length !== manifest.runs.length
  ) {
    throw new Error(
      'Nested manifest has incomplete run or artifact evidence',
    );
  }
  for (const [index, runConfig] of manifest.runs.entries()) {
    if (manifest.expectedArtifacts[index]?.runID !== runID(runConfig)) {
      throw new Error(
        `Expected artifact ${index + 1} does not match its manifest run`,
      );
    }
  }
  if (
    manifest.selection?.selectedRunCount !== manifest.runs.length ||
    !Number.isInteger(manifest.selection?.plannedRunCount) ||
    manifest.selection.plannedRunCount < manifest.runs.length ||
    !Number.isInteger(manifest.selection?.plannedBlocks) ||
    manifest.selection.plannedBlocks < 1 ||
    !Array.isArray(manifest.selection?.selectedBlocks) ||
    manifest.selection.selectedBlocks.length < 1 ||
    manifest.selection.selectedBlocks.length > manifest.selection.plannedBlocks
  ) {
    throw new Error('Nested manifest has invalid run selection evidence');
  }
  if (manifest.mode === 'canonical') {
    if (
      manifest.selection?.completeStage !== true ||
      manifest.selection?.selectedRunCount !== manifest.runs.length ||
      manifest.selection?.plannedRunCount !== manifest.runs.length ||
      manifest.analysisPlan?.plannedSampleCount !== manifest.runs.length ||
      manifest.selection.selectedBlocks.length !==
        manifest.selection.plannedBlocks ||
      manifest.analysisPlan?.plannedBlocks !== manifest.selection.plannedBlocks
    ) {
      throw new Error(
        'Canonical manifest does not contain the complete fixed plan',
      );
    }
    const expectedBlocks = Array.from(
      {length: manifest.selection.plannedBlocks},
      (_, index) => index + 1,
    );
    if (
      JSON.stringify(manifest.selection.selectedBlocks) !==
      JSON.stringify(expectedBlocks)
    ) {
      throw new Error('Canonical manifest selected blocks are incomplete');
    }
  }

  for (const [index, operation] of manifest.operations.entries()) {
    const artifact = manifest.expectedArtifacts[index];
    if (
      operation.index !== index + 1 ||
      operation.status !== 0 ||
      operation.artifact !== artifact.path ||
      operation.id !== artifact.runID ||
      !Number.isFinite(Date.parse(operation.startedAt)) ||
      !Number.isFinite(Date.parse(operation.completedAt)) ||
      Date.parse(operation.startedAt) < Date.parse(manifest.generatedAt) ||
      Date.parse(operation.completedAt) < Date.parse(operation.startedAt) ||
      Date.parse(operation.completedAt) > Date.parse(manifest.completedAt)
    ) {
      throw new Error(
        `Nested operation ${index + 1} evidence is incomplete`,
      );
    }
  }
  return manifest.mode === 'canonical';
}

function validateExpectedArtifact(artifact) {
  if (
    artifact?.kind !== 'operation-log' ||
    artifact.status !== 'complete' ||
    typeof artifact.runID !== 'string' ||
    !SHA256.test(artifact.sha256 ?? '') ||
    typeof artifact.path !== 'string' ||
    !/^operations\/[a-zA-Z0-9._-]+\.log$/.test(artifact.path)
  ) {
    throw new Error(
      'Manifest contains an invalid or incomplete expected artifact',
    );
  }
}

function parseUniqueLine(text, prefix, file) {
  const lines = text
    .split('\n')
    .filter(candidate => candidate.startsWith(prefix));
  if (lines.length > 1) {
    throw new Error(`Duplicate ${prefix.trim()} records in ${file}`);
  }
  if (!lines.length) {
    return undefined;
  }
  try {
    return JSON.parse(lines[0].slice(prefix.length));
  } catch (error) {
    throw new Error(`Invalid ${prefix.trim()} JSON in ${file}`, {cause: error});
  }
}

function validateRunToken(runToken) {
  if (!RUN_TOKEN.test(runToken) || runToken === '.' || runToken === '..') {
    throw new Error(`Invalid run token ${runToken}`);
  }
}
