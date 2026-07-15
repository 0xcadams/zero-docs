import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  analyzePairedRatios,
  median,
  reconcileArtifacts,
  stableStringify,
  treatmentLabel,
} from './analysis.mjs';
import {loadArtifactSet, parseRunArtifacts} from './artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2];
const baselineLabel = process.argv[3] ?? 'baseline';
if (!stage) {
  throw new Error(
    'Usage: node scripts/summarize-integration.mjs <stage> [baseline-label]',
  );
}

const aggregate = await readJSON(`results/${stage}.json`);
if (aggregate.stage !== stage) {
  throw new Error(
    `Aggregate stage ${aggregate.stage} does not match requested stage ${stage}`,
  );
}
const artifactSet = await loadArtifactSet({
  root,
  stage,
  runToken:
    aggregate.artifactSource?.kind === 'nested-immutable'
      ? aggregate.artifactSource.runToken
      : undefined,
  forceLegacy: aggregate.artifactSource?.kind !== 'nested-immutable',
});
const {manifest} = artifactSet;
const artifactRuns = parseRunArtifacts(artifactSet.files);
const reconciliation = reconcileArtifacts(manifest, artifactRuns, {
  canonicalArtifact: artifactSet.canonical,
});
const conditionVariantsByProfile = new Map();
for (const condition of reconciliation.conditions) {
  const variants =
    conditionVariantsByProfile.get(condition.condition.profile) ?? new Set();
  variants.add(condition.key);
  conditionVariantsByProfile.set(condition.condition.profile, variants);
}
const runLocations = new Map(
  reconciliation.conditions.flatMap(condition =>
    condition.blocks.flatMap(block =>
      block.runs.map(run => [
        run.id,
        {
          conditionKey: condition.key,
          condition: condition.condition,
          block: block.repetition,
          position: run.position,
          blockSize: block.runs.length,
        },
      ]),
    ),
  ),
);

const groups = new Map();
const runsByID = new Map();
const runMetrics = [];
for (const run of artifactRuns) {
  if (run.result.kind !== 'initial-sync') {
    throw new Error(
      `Integration summary requires initial-sync results; ${run.file} is ${run.result.kind}`,
    );
  }
  const {profile} = run.meta.runConfig;
  const label = treatmentLabel(run.meta.runConfig);
  const location = runLocations.get(run.meta.id);
  if (!location) {
    throw new Error(`Run ${run.meta.id} is not located in a manifest block`);
  }
  const summary = run.result.phases?.summary ?? {};
  const dominant = (run.result.phases?.tableCopies ?? [])
    .map(record => record.data)
    .filter(Boolean)
    .sort((a, b) => (b.copyBytes ?? 0) - (a.copyBytes ?? 0))[0];
  const values = {
    id: run.meta.id,
    file: run.file,
    profile,
    label,
    repetition: run.meta.runConfig.repetition,
    block: location.block,
    order: location.position,
    blockSize: location.blockSize,
    conditionKey: location.conditionKey,
    condition: location.condition,
    outerMs: run.result.timing?.outerMs,
    callbackMs: run.result.timing?.callbackMs,
    wrapperMs: run.result.timing?.wrapperMs,
    copyMs: summary.copyMs,
    flushMs: summary.flushMs,
    indexMs: summary.indexMs,
    copyOtherMs: summary.copyOtherMs,
    totalMs: summary.totalMs,
    insertStatementCount: summary.insertStatementCount,
    rawCopyMs: run.result.rawCopy?.ms,
    rawCopyMBps: run.result.rawCopy?.throughputMBps,
    rawChunkBytes: run.result.rawCopy?.averageChunkBytes,
    callbackMinusRawMs:
      run.result.timing?.callbackMs === undefined ||
      run.result.rawCopy?.ms === undefined
        ? undefined
        : run.result.timing.callbackMs - run.result.rawCopy.ms,
    callbackToRawRatio:
      run.result.timing?.callbackMs === undefined || !run.result.rawCopy?.ms
        ? undefined
        : run.result.timing.callbackMs / run.result.rawCopy.ms,
    dominantElapsedMs: dominant?.elapsedMs,
    dominantFlushMs: dominant?.flushMs,
    dominantCopyBytes: dominant?.copyBytes,
    dominantInsertStatements: dominant?.insertStatementCount,
    dominantSourceWaitMs: dominant?.sourceWaitMs,
    dominantProcessingMs: dominant?.processingMs,
    dominantParameterArrayMs: dominant?.parameterArrayMs,
    dominantStatementMs: dominant?.statementMs,
    dominantFlushCount: dominant?.flushCount,
    dominantMaxFlushMs: dominant?.maxFlushMs,
    dominantAllocatedFieldBuffers: dominant?.allocatedFieldBuffers,
    dominantReusedFieldBuffers: dominant?.reusedFieldBuffers,
    dominantPooledFieldBufferBytes: dominant?.pooledFieldBufferBytes,
    peakRssBytes: run.result.peakRssBytes,
    gcCount: run.result.gc?.count,
    gcMs: run.result.gc?.ms,
    eventLoopUtilization: run.result.eventLoopUtilization?.utilization,
    userCPUTime: run.result.resourceUsage?.userCPUTime,
    systemCPUTime: run.result.resourceUsage?.systemCPUTime,
    minorPageFaults: run.result.resourceUsage?.minorPageFault,
    scopedMemoryPressureFullUs: diagnosticDelta(
      run,
      'memoryPressure',
      'full',
      'total',
    ),
    scopedIOPressureFullUs: diagnosticDelta(run, 'ioPressure', 'full', 'total'),
    scopedIOReadBytes: diagnosticDelta(run, 'ioStat', 'rbytes'),
    scopedIOWriteBytes: diagnosticDelta(run, 'ioStat', 'wbytes'),
    scopedMemoryMaxEvents: diagnosticDelta(run, 'memoryEvents', 'max'),
    cgroupMemoryMaxEvents: run.cgroup?.memoryEvents?.max,
    sqliteFileBytes: run.result.sqlite?.fileBytes,
  };
  if (!(values.outerMs > 0)) {
    throw new Error(`Run ${run.meta.id} has no positive timing.outerMs`);
  }
  const key = `${location.conditionKey}\u0000${label}`;
  const group = groups.get(key) ?? [];
  group.push(values);
  groups.set(key, group);
  runsByID.set(values.id, values);
  runMetrics.push(values);
}

const metrics = [
  'outerMs',
  'callbackMs',
  'wrapperMs',
  'copyMs',
  'flushMs',
  'indexMs',
  'copyOtherMs',
  'totalMs',
  'insertStatementCount',
  'rawCopyMs',
  'rawCopyMBps',
  'rawChunkBytes',
  'callbackMinusRawMs',
  'callbackToRawRatio',
  'dominantElapsedMs',
  'dominantFlushMs',
  'dominantCopyBytes',
  'dominantInsertStatements',
  'dominantSourceWaitMs',
  'dominantProcessingMs',
  'dominantParameterArrayMs',
  'dominantStatementMs',
  'dominantFlushCount',
  'dominantMaxFlushMs',
  'dominantAllocatedFieldBuffers',
  'dominantReusedFieldBuffers',
  'dominantPooledFieldBufferBytes',
  'peakRssBytes',
  'gcCount',
  'gcMs',
  'eventLoopUtilization',
  'userCPUTime',
  'systemCPUTime',
  'minorPageFaults',
  'scopedMemoryPressureFullUs',
  'scopedIOPressureFullUs',
  'scopedIOReadBytes',
  'scopedIOWriteBytes',
  'scopedMemoryMaxEvents',
  'cgroupMemoryMaxEvents',
  'sqliteFileBytes',
];

// These two paths retain the old median and ratio-of-medians shapes for readers
// of archived benchmark output. They are not the confirmatory analysis.
const summary = {};
for (const values of groups.values()) {
  const key = `${displayCondition(values[0].condition)}/${values[0].label}`;
  if (summary[key]) {
    throw new Error(`Exploratory summary key collision for ${key}`);
  }
  summary[key] = Object.fromEntries(
    metrics.map(metric => [
      metric,
      median(
        values.map(run => run[metric]).filter(value => Number.isFinite(value)),
      ),
    ]),
  );
}

const comparisons = {};
for (const condition of reconciliation.conditions) {
  const baselineRuns = groups.get(`${condition.key}\u0000${baselineLabel}`);
  if (!baselineRuns) {
    continue;
  }
  const baseline =
    summary[`${displayCondition(condition.condition)}/${baselineLabel}`];
  for (const candidateLabel of condition.arms) {
    if (candidateLabel === baselineLabel) {
      continue;
    }
    const candidateRuns = groups.get(`${condition.key}\u0000${candidateLabel}`);
    const candidate =
      summary[`${displayCondition(condition.condition)}/${candidateLabel}`];
    const key = `${displayCondition(condition.condition)}/${candidateLabel} vs ${baselineLabel}`;
    comparisons[key] = Object.fromEntries(
      [
        'outerMs',
        'callbackMs',
        'copyMs',
        'flushMs',
        'indexMs',
        'copyOtherMs',
        'rawCopyMs',
        'callbackMinusRawMs',
        'callbackToRawRatio',
        'dominantElapsedMs',
        'dominantFlushMs',
        'peakRssBytes',
        'gcCount',
        'gcMs',
        'scopedMemoryPressureFullUs',
        'scopedIOPressureFullUs',
        'scopedMemoryMaxEvents',
      ].map(metric => [
        metric,
        metricComparison(
          metric,
          baseline,
          candidate,
          baselineRuns,
          candidateRuns,
        ),
      ]),
    );
  }
}

const primaryComparisons = [];
for (const condition of reconciliation.conditions) {
  if (!condition.arms.includes(baselineLabel)) {
    continue;
  }
  for (const candidateLabel of condition.arms) {
    if (candidateLabel === baselineLabel) {
      continue;
    }
    const pairs = condition.blocks.map(block => {
      const baselineRun = block.runs.find(run => run.arm === baselineLabel);
      const candidateRun = block.runs.find(run => run.arm === candidateLabel);
      const baseline = runsByID.get(baselineRun.id);
      const candidate = runsByID.get(candidateRun.id);
      return {
        block: block.repetition,
        baselineRunID: baseline.id,
        candidateRunID: candidate.id,
        baselineOrder: baselineRun.position,
        candidateOrder: candidateRun.position,
        blockSize: block.runs.length,
        baselineValue: baseline.outerMs,
        candidateValue: candidate.outerMs,
        order:
          candidateRun.position > baselineRun.position
            ? 'candidate-after-baseline'
            : 'candidate-before-baseline',
      };
    });
    const plannedBlocks = plannedBlockCount(manifest.analysisPlan, condition);
    primaryComparisons.push({
      id: `${condition.key}/${candidateLabel}-vs-${baselineLabel}`,
      condition: condition.condition,
      baseline: baselineLabel,
      candidate: candidateLabel,
      primaryMetric: 'outerMs',
      plannedBlocks,
      observedCompleteBlocks: pairs.length,
      ...analyzePairedRatios({
        id: `${stage}/${condition.key}/${candidateLabel}-vs-${baselineLabel}/outerMs`,
        pairs,
        reconciliation,
        plannedBlocks,
      }),
    });
  }
}

const output = {
  schemaVersion: 2,
  stage,
  generatedAt: new Date().toISOString(),
  primaryMetric: {
    name: 'outerMs',
    description: 'Whole awaited initReplica wall time through readiness',
    role: 'primary',
  },
  attributionMetrics: metrics.filter(metric => metric !== 'outerMs'),
  artifactSource: artifactSet.source,
  artifactReconciliation: reconciliation,
  analysis: {
    classification: reconciliation.classification,
    classificationReason: reconciliation.classificationReason,
    experimentalUnit:
      'independent pair or complete multi-arm block; in-process measurements are not independent evidence',
    plannedSampleCount: reconciliation.plannedSampleCount,
    observedSampleCount: reconciliation.actualRunCount,
    minimumPairedBlocks: reconciliation.minimumPairedBlocks,
    bootstrapResamples: reconciliation.bootstrapResamples,
    fixedSamplePolicy:
      'Gate status remains inconclusive without a predeclared analysis plan and until its fixed sample count is reached.',
    runs: runMetrics,
    primaryComparisons,
  },
  compatibility: {
    summary:
      'Noncanonical exploratory medians retained at the historical path.',
    comparisons:
      'Noncanonical exploratory ratio-of-medians and paired-median views retained at the historical path.',
    p95: 'No across-run p95 is reported because fixed-N benchmark groups are too small for a useful tail-percentile claim.',
  },
  summary,
  comparisons,
};
await writeFile(
  join(root, 'results', `${stage}-summary.json`),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));

function diagnosticDelta(run, ...path) {
  let before = run.result.linuxDiagnostics?.before;
  let after = run.result.linuxDiagnostics?.after;
  for (const key of path) {
    before = before?.[key];
    after = after?.[key];
  }
  return typeof before === 'number' && typeof after === 'number'
    ? after - before
    : undefined;
}

function metricComparison(
  metric,
  baseline,
  candidate,
  baselineRuns,
  candidateRuns,
) {
  if (
    !Number.isFinite(baseline?.[metric]) ||
    baseline[metric] === 0 ||
    !Number.isFinite(candidate?.[metric])
  ) {
    return undefined;
  }
  const ratio = candidate[metric] / baseline[metric];
  const baselineByBlock = new Map(
    baselineRuns.map(run => [run.block, run[metric]]),
  );
  const pairedRatios = candidateRuns
    .map(run => {
      const baselineValue = baselineByBlock.get(run.block);
      return Number.isFinite(baselineValue) &&
        baselineValue !== 0 &&
        Number.isFinite(run[metric])
        ? run[metric] / baselineValue
        : undefined;
    })
    .filter(value => Number.isFinite(value));
  const pairedRatio = median(pairedRatios);
  return {
    ratio,
    changePercent: (ratio - 1) * 100,
    pairedRatio,
    pairedChangePercent:
      pairedRatio === undefined ? undefined : (pairedRatio - 1) * 100,
  };
}

function plannedBlockCount(analysisPlan, condition) {
  if (analysisPlan?.plannedBlocks !== undefined) {
    if (
      !Number.isInteger(analysisPlan.plannedBlocks) ||
      analysisPlan.plannedBlocks < 1
    ) {
      throw new Error('analysisPlan.plannedBlocks must be a positive integer');
    }
    if (condition.blockCount > analysisPlan.plannedBlocks) {
      throw new Error(
        `Condition ${condition.key} has more blocks than analysisPlan.plannedBlocks`,
      );
    }
    return analysisPlan.plannedBlocks;
  }
  if (analysisPlan?.plannedBlocksByCondition) {
    const value =
      analysisPlan.plannedBlocksByCondition[condition.key] ??
      analysisPlan.plannedBlocksByCondition[condition.condition.profile];
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(
          'analysisPlan.plannedBlocksByCondition values must be positive integers',
        );
      }
      if (condition.blockCount > value) {
        throw new Error(
          `Condition ${condition.key} has more blocks than its planned block count`,
        );
      }
      return value;
    }
  }
  return condition.blockCount;
}

function displayCondition(condition) {
  if (conditionVariantsByProfile.get(condition.profile)?.size === 1) {
    return condition.profile;
  }
  const supplemental = Object.fromEntries(
    Object.entries(condition).filter(([key]) => key !== 'profile'),
  );
  return Object.keys(supplemental).length
    ? `${condition.profile}|${stableStringify(supplemental)}`
    : condition.profile;
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}
