import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzePairedRatios,
  primaryRunMetric,
  reconcileArtifacts,
  runID,
  validateManifestBlocks,
} from './analysis.mjs';

const POSITIVE_RATIOS = [0.88, 0.9, 0.91, 0.89, 0.92, 0.9, 0.89, 0.91];
const REGRESSION_RATIOS = [1.06, 1.07, 1.05, 1.08, 1.06, 1.07];
const NOISY_RATIOS = [0.8, 1.2, 0.82, 1.18, 0.78, 1.22, 0.81, 1.19];

test('positive fixture passes the performance-gain gate deterministically', () => {
  const fixture = pairedFixture(POSITIVE_RATIOS);
  const first = analyzeFixture(fixture, POSITIVE_RATIOS);
  const second = analyzeFixture(fixture, POSITIVE_RATIOS);

  assert.equal(first.status, 'performance-gain');
  assert.equal(first.pairedRatios.length, POSITIVE_RATIOS.length);
  assert.ok(first.estimates.medianRatio <= 0.95);
  assert.ok(first.bootstrap95CI.ratio.upper < 1);
  assert.equal(first.bootstrap95CI.resamples, 10_000);
  assert.deepEqual(first.bootstrap95CI, second.bootstrap95CI);
});

test('regression fixture reports a confident practical regression', () => {
  const fixture = pairedFixture(REGRESSION_RATIOS);
  const analysis = analyzeFixture(fixture, REGRESSION_RATIOS);

  assert.equal(analysis.status, 'regression');
  assert.ok(analysis.estimates.medianRatio > 1.02);
  assert.ok(analysis.bootstrap95CI.ratio.lower > 1);
});

test('narrow neutral fixture passes the no-regression gate', () => {
  const ratios = [0.99, 1.0, 1.01, 1.0, 0.995, 1.005];
  const fixture = pairedFixture(ratios);
  const analysis = analyzeFixture(fixture, ratios);

  assert.equal(analysis.status, 'no-regression');
  assert.equal(analysis.gates.noRegression.pass, true);
});

test('noisy fixture remains inconclusive', () => {
  const fixture = pairedFixture(NOISY_RATIOS);
  const analysis = analyzeFixture(fixture, NOISY_RATIOS);

  assert.equal(analysis.status, 'inconclusive');
  assert.equal(analysis.gates.performanceGain.pass, false);
  assert.equal(analysis.gates.noRegression.pass, false);
  assert.ok(analysis.bootstrap95CI.ratio.lower < 1);
  assert.ok(analysis.bootstrap95CI.ratio.upper > 1.03);
});

test('order-effect fixture reports AB versus BA geometric means', () => {
  const ratios = [0.8, 1.2, 0.8, 1.2, 0.8, 1.2];
  const fixture = pairedFixture(ratios);
  const analysis = analyzeFixture(fixture, ratios);

  assert.equal(analysis.orderEffect.assessable, true);
  assert.equal(analysis.orderEffect.candidateAfterBaseline.n, 3);
  assert.equal(analysis.orderEffect.candidateBeforeBaseline.n, 3);
  assert.ok(analysis.orderEffect.ratioOfGeometricMeansAfterOverBefore < 0.7);
});

test('fixed-N plan remains incomplete until its planned sample count', () => {
  const fixture = pairedFixture(POSITIVE_RATIOS.slice(0, 6));
  fixture.manifest.analysisPlan.plannedSampleCount += 4;
  fixture.manifest.analysisPlan.plannedBlocks += 2;
  const reconciliation = reconcileArtifacts(fixture.manifest, fixture.runs);
  const analysis = analyzeRatios(
    POSITIVE_RATIOS.slice(0, 6),
    reconciliation,
    8,
  );

  assert.equal(reconciliation.classification, 'incomplete');
  assert.equal(analysis.status, 'inconclusive');
  assert.equal(analysis.gates.prerequisites.plannedSampleCountReached, false);
  assert.equal(analysis.gates.performanceGain.pass, null);
});

test('balanced complete multi-arm blocks are accepted', () => {
  const manifest = makeManifest([
    runConfig('baseline', 1),
    runConfig('candidate', 1),
    runConfig('third-arm', 1),
    runConfig('third-arm', 2),
    runConfig('candidate', 2),
    runConfig('baseline', 2),
  ]);
  const validation = validateManifestBlocks(manifest);

  assert.equal(validation.conditions.length, 1);
  assert.deepEqual(validation.conditions[0].arms, [
    'baseline',
    'candidate',
    'third-arm',
  ]);
  assert.equal(validation.conditions[0].blockCount, 2);
});

test('in-process repetitions reduce to one process-level statistic', () => {
  assert.equal(
    primaryRunMetric({samples: [{wallMs: 1}, {wallMs: 100}, {wallMs: 3}]}),
    3,
  );
});

test('artifact reconciliation rejects stale, extra, missing, and duplicate runs', async t => {
  await t.test('stale', () => {
    const fixture = pairedFixture([0.9, 0.91]);
    fixture.runs[0].meta.startedAt = '2025-12-31T23:59:59.000Z';
    assert.throws(
      () => reconcileArtifacts(fixture.manifest, fixture.runs),
      /stale run predates the manifest/,
    );
  });

  await t.test('extra', () => {
    const fixture = pairedFixture([0.9, 0.91]);
    fixture.runs.push(makeRun(runConfig('extra', 1)));
    assert.throws(
      () => reconcileArtifacts(fixture.manifest, fixture.runs),
      /extra runs: fixture-extra-r1/,
    );
  });

  await t.test('missing', () => {
    const fixture = pairedFixture([0.9, 0.91]);
    const missing = fixture.runs.pop();
    assert.throws(
      () => reconcileArtifacts(fixture.manifest, fixture.runs),
      new RegExp(`missing runs: ${missing.meta.id}`),
    );
  });

  await t.test('duplicate', () => {
    const fixture = pairedFixture([0.9, 0.91]);
    fixture.runs.push(structuredClone(fixture.runs[0]));
    assert.throws(
      () => reconcileArtifacts(fixture.manifest, fixture.runs),
      /duplicate run fixture-baseline-r1/,
    );
  });
});

test('Docker constraints reconcile at their declared metadata location', () => {
  const config = {...runConfig('baseline', 1), constraints: {cpus: 2}};
  const manifest = makeManifest([config]);
  const run = makeRun(structuredClone(config));
  delete run.meta.runConfig.constraints;
  run.meta.constraints = {cpus: 2};

  assert.equal(reconcileArtifacts(manifest, [run]).status, 'complete');
  run.meta.constraints.cpus = 4;
  assert.throws(
    () => reconcileArtifacts(manifest, [run]),
    /runConfig does not exactly match the manifest/,
  );
});

test('manifest validation rejects an incomplete block', () => {
  const manifest = makeManifest([
    runConfig('baseline', 1),
    runConfig('candidate', 1),
    runConfig('baseline', 2),
  ]);

  assert.throws(
    () => validateManifestBlocks(manifest),
    /Incomplete or unbalanced block 2/,
  );
});

function pairedFixture(ratios) {
  const configs = ratios.flatMap((_, index) => {
    const repetition = index + 1;
    const pair = [
      runConfig('baseline', repetition),
      runConfig('candidate', repetition),
    ];
    return repetition % 2 === 1 ? pair : pair.reverse();
  });
  const manifest = makeManifest(configs, {
    plannedSampleCount: configs.length,
    plannedBlocks: ratios.length,
    minimumPairedBlocks: 5,
    bootstrapResamples: 10_000,
  });
  return {manifest, runs: configs.map(makeRun)};
}

function analyzeFixture(fixture, ratios) {
  const reconciliation = reconcileArtifacts(fixture.manifest, fixture.runs);
  return analyzeRatios(ratios, reconciliation, ratios.length);
}

function analyzeRatios(ratios, reconciliation, plannedBlocks) {
  return analyzePairedRatios({
    id: 'deterministic-fixture/candidate-vs-baseline',
    reconciliation,
    plannedBlocks,
    pairs: ratios.map((ratio, index) => ({
      block: index + 1,
      baselineRunID: `baseline-${index + 1}`,
      candidateRunID: `candidate-${index + 1}`,
      baselineOrder: index % 2 === 0 ? 1 : 2,
      candidateOrder: index % 2 === 0 ? 2 : 1,
      baselineValue: 100,
      candidateValue: 100 * ratio,
      order:
        index % 2 === 0
          ? 'candidate-after-baseline'
          : 'candidate-before-baseline',
    })),
  });
}

function makeManifest(runs, analysisPlan) {
  return {
    stage: 'fixture',
    generatedAt: '2026-01-01T00:00:00.000Z',
    runs,
    ...(analysisPlan ? {analysisPlan} : {}),
  };
}

function runConfig(label, repetition) {
  return {
    profile: 'fixture',
    worktree: label,
    label,
    repetition,
  };
}

function makeRun(runConfigValue) {
  const id = runID(runConfigValue);
  return {
    file: `${id}.log`,
    meta: {
      id,
      startedAt: '2026-01-01T00:00:01.000Z',
      runConfig: runConfigValue,
    },
    result: {
      kind: 'initial-sync',
      profile: runConfigValue.profile,
      runLabel: id,
      timing: {outerMs: 100},
    },
    exit: {status: 0},
  };
}
