import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {reconcileArtifacts, runID} from './analysis.mjs';
import {loadArtifactSet, parseRunArtifacts} from './artifacts.mjs';

test('nested canonical complete artifacts load and reconcile', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {token: 'run-complete'});

  const artifactSet = await loadArtifactSet({
    root,
    stage: 'fixture-docker',
    runToken: 'run-complete',
  });
  const runs = parseRunArtifacts(artifactSet.files);
  const reconciliation = reconcileArtifacts(artifactSet.manifest, runs, {
    canonicalArtifact: artifactSet.canonical,
  });

  assert.equal(artifactSet.source.kind, 'nested-immutable');
  assert.equal(artifactSet.canonical, true);
  assert.equal(runs.length, 2);
  assert.equal(reconciliation.classification, 'confirmatory-eligible');
});

test('nested noncanonical partial artifacts load as exploratory', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {
    token: 'run-noncanonical',
    mutateManifest(manifest) {
      manifest.mode = 'noncanonical';
      manifest.evidence = {
        eligible: false,
        classification: 'noncanonical',
        reasons: [
          'runner was explicitly noncanonical',
          'stage selection is incomplete',
        ],
      };
      manifest.selection.completeStage = false;
      manifest.selection.plannedBlocks = 2;
      manifest.selection.plannedRunCount = 4;
      delete manifest.analysisPlan;
    },
  });

  const artifactSet = await loadArtifactSet({
    root,
    stage: 'fixture-docker',
    runToken: 'run-noncanonical',
  });
  const reconciliation = reconcileArtifacts(
    artifactSet.manifest,
    parseRunArtifacts(artifactSet.files),
    {canonicalArtifact: artifactSet.canonical},
  );

  assert.equal(artifactSet.source.kind, 'nested-immutable');
  assert.equal(artifactSet.canonical, false);
  assert.equal(reconciliation.classification, 'exploratory-noncanonical');
});

test('nested canonical artifacts reject a hash mismatch', async t => {
  const root = await temporaryRoot(t);
  const {operationPaths} = await writeCanonicalRun(root, {
    token: 'run-bad-hash',
  });
  await writeFile(operationPaths[0], 'stale replacement');

  await assert.rejects(
    loadArtifactSet({
      root,
      stage: 'fixture-docker',
      runToken: 'run-bad-hash',
    }),
    /SHA-256 mismatch/,
  );
});

test('nested canonical artifacts reject an extra operation artifact', async t => {
  const root = await temporaryRoot(t);
  const {operationsDirectory} = await writeCanonicalRun(root, {
    token: 'run-extra',
  });
  await writeFile(join(operationsDirectory, 'stale.log'), 'stale');

  await assert.rejects(
    loadArtifactSet({
      root,
      stage: 'fixture-docker',
      runToken: 'run-extra',
    }),
    /extra artifacts: operations\/stale\.log/,
  );
});

test('nested canonical artifacts reject incomplete status and evidence', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {
    token: 'run-incomplete',
    mutateManifest(manifest) {
      manifest.status = 'running';
      manifest.evidence = {
        eligible: false,
        classification: 'incomplete',
        reasons: ['execution is incomplete'],
      };
    },
  });

  await assert.rejects(
    loadArtifactSet({
      root,
      stage: 'fixture-docker',
      runToken: 'run-incomplete',
    }),
    /execution status is incomplete/,
  );
});

test('nested canonical artifacts reject the wrong stage', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {
    token: 'run-wrong-stage',
    mutateManifest(manifest) {
      manifest.stage = 'another-stage';
    },
  });

  await assert.rejects(
    loadArtifactSet({
      root,
      stage: 'fixture-docker',
      runToken: 'run-wrong-stage',
    }),
    /does not match requested stage fixture/,
  );
});

test('nested canonical artifacts reject the wrong run token', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {
    token: 'run-token-directory',
    mutateManifest(manifest) {
      manifest.runToken = 'different-run-token';
    },
  });

  await assert.rejects(
    loadArtifactSet({
      root,
      stage: 'fixture-docker',
      runToken: 'run-token-directory',
    }),
    /does not match directory run-token-directory/,
  );
});

test('implicit latest-run selection fails when multiple runs exist', async t => {
  const root = await temporaryRoot(t);
  await writeCanonicalRun(root, {token: 'run-one'});
  await writeCanonicalRun(root, {token: 'run-two'});

  await assert.rejects(
    loadArtifactSet({root, stage: 'fixture-docker'}),
    /Multiple immutable runs exist.*specify an exact run token/,
  );
});

test('flat manifests remain explicitly legacy exploratory', async t => {
  const root = await temporaryRoot(t);
  const stageDirectory = join(root, 'raw', 'legacy-stage');
  const manifestDirectory = join(root, 'manifests');
  await mkdir(stageDirectory, {recursive: true});
  await mkdir(manifestDirectory, {recursive: true});
  const runConfig = {
    profile: 'fixture',
    worktree: 'baseline',
    repetition: 1,
  };
  const id = runID(runConfig);
  const text = [
    `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify({startedAt: '2026-01-01T00:00:01.000Z', id, runConfig})}`,
    `ZERO_COPY_PIPELINE_RESULT ${JSON.stringify({kind: 'initial-sync', profile: 'fixture', runLabel: id, timing: {outerMs: 100}})}`,
    'ZERO_COPY_PIPELINE_EXIT {"status":0,"signal":null}',
  ].join('\n');
  await writeFile(join(stageDirectory, `${id}.log`), text);
  await writeFile(
    join(manifestDirectory, 'legacy-stage.json'),
    JSON.stringify({
      stage: 'legacy-stage',
      generatedAt: '2026-01-01T00:00:00.000Z',
      analysisPlan: {plannedSampleCount: 1},
      runs: [runConfig],
    }),
  );

  const artifactSet = await loadArtifactSet({
    root,
    stage: 'legacy-stage',
    forceLegacy: true,
  });
  const reconciliation = reconcileArtifacts(
    artifactSet.manifest,
    parseRunArtifacts(artifactSet.files),
    {canonicalArtifact: artifactSet.canonical},
  );

  assert.equal(artifactSet.source.kind, 'legacy-flat');
  assert.equal(reconciliation.classification, 'exploratory-noncanonical');
  assert.equal(reconciliation.canonicalArtifact, false);
});

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'zero-artifact-analysis-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function writeCanonicalRun(root, {token, mutateManifest = () => {}}) {
  const stageDirectory = join(root, 'raw', 'fixture-docker', token);
  const operationsDirectory = join(stageDirectory, 'operations');
  await mkdir(operationsDirectory, {recursive: true});
  const generatedAt = '2026-01-01T00:00:00.000Z';
  const completedAt = '2026-01-01T00:00:10.000Z';
  const runConfigs = [
    {
      profile: 'fixture',
      worktree: 'baseline',
      label: 'baseline',
      repetition: 1,
    },
    {
      profile: 'fixture',
      worktree: 'candidate',
      label: 'candidate',
      repetition: 1,
    },
  ];
  const expectedArtifacts = [];
  const operations = [];
  const operationPaths = [];
  for (const [index, runConfig] of runConfigs.entries()) {
    const id = runID(runConfig);
    const artifactPath = `operations/${String(index + 1).padStart(3, '0')}-${id}.log`;
    const startedAt = `2026-01-01T00:00:0${index + 1}.000Z`;
    const text = [
      `ZERO_COPY_PIPELINE_RUN_META ${JSON.stringify({startedAt, id, runConfig})}`,
      `ZERO_COPY_PIPELINE_RESULT ${JSON.stringify({kind: 'initial-sync', profile: 'fixture', runLabel: id, timing: {outerMs: index === 0 ? 100 : 90}, phases: {summary: {}, tableCopies: []}, rawCopy: {ms: 50}})}`,
      'ZERO_COPY_PIPELINE_EXIT {"status":0,"signal":null}',
    ].join('\n');
    const operationPath = join(stageDirectory, artifactPath);
    await writeFile(operationPath, text);
    operationPaths.push(operationPath);
    expectedArtifacts.push({
      path: artifactPath,
      kind: 'operation-log',
      runID: id,
      status: 'complete',
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    operations.push({
      index: index + 1,
      id,
      artifact: artifactPath,
      startedAt,
      completedAt: `2026-01-01T00:00:0${index + 2}.000Z`,
      status: 0,
      signal: null,
    });
  }
  const manifest = {
    schemaVersion: 2,
    stage: 'fixture',
    runToken: token,
    generatedAt,
    completedAt,
    mode: 'canonical',
    execute: true,
    status: 'complete',
    evidence: {
      eligible: true,
      classification: 'canonical-complete',
      reasons: [],
    },
    platform: 'linux/arm64',
    selection: {
      completeStage: true,
      selectedBlocks: [1],
      plannedBlocks: 1,
      selectedRunCount: 2,
      plannedRunCount: 2,
    },
    analysisPlan: {
      plannedSampleCount: 2,
      plannedBlocks: 1,
      minimumPairedBlocks: 1,
      bootstrapResamples: 10_000,
    },
    expectedArtifacts,
    runs: runConfigs,
    operations,
  };
  mutateManifest(manifest);
  await writeFile(
    join(stageDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assert.equal(
    JSON.parse(await readFile(join(stageDirectory, 'manifest.json'))).runToken,
    manifest.runToken,
  );
  return {operationsDirectory, operationPaths};
}
