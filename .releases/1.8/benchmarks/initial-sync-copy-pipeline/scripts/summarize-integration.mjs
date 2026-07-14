import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2];
const baselineLabel = process.argv[3] ?? 'baseline';
if (!stage) {
  throw new Error(
    'Usage: node scripts/summarize-integration.mjs <stage> [baseline-label]',
  );
}
const aggregate = JSON.parse(
  await readFile(join(root, 'results', `${stage}.json`), 'utf8'),
);
const groups = new Map();
for (const run of aggregate.runs) {
  const {profile, label} = run.meta.runConfig;
  const key = `${profile}/${label}`;
  const summary = run.result.phases.summary ?? {};
  const dominant = run.result.phases.tableCopies
    .map(record => record.data)
    .filter(Boolean)
    .sort((a, b) => (b.copyBytes ?? 0) - (a.copyBytes ?? 0))[0];
  const values = groups.get(key) ?? [];
  values.push({
    repetition: run.meta.runConfig.repetition,
    callbackMs: run.result.timing.callbackMs,
    outerMs: run.result.timing.outerMs,
    wrapperMs: run.result.timing.wrapperMs,
    copyMs: summary.copyMs,
    flushMs: summary.flushMs,
    indexMs: summary.indexMs,
    copyOtherMs: summary.copyOtherMs,
    totalMs: summary.totalMs,
    insertStatementCount: summary.insertStatementCount,
    rawCopyMs: run.result.rawCopy.ms,
    rawCopyMBps: run.result.rawCopy.throughputMBps,
    rawChunkBytes: run.result.rawCopy.averageChunkBytes,
    callbackMinusRawMs: run.result.timing.callbackMs - run.result.rawCopy.ms,
    callbackToRawRatio: run.result.timing.callbackMs / run.result.rawCopy.ms,
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
    dominantP95FlushMs: dominant?.p95FlushMs,
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
    sqliteFileBytes: run.result.sqlite.fileBytes,
  });
  groups.set(key, values);
}

const metrics = [
  'callbackMs',
  'outerMs',
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
  'dominantP95FlushMs',
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
const summary = {};
for (const [key, runs] of groups) {
  summary[key] = Object.fromEntries(
    metrics.map(metric => [
      metric,
      median(
        runs.map(run => run[metric]).filter(value => typeof value === 'number'),
      ),
    ]),
  );
}

const comparisons = {};
for (const profile of new Set(
  [...groups.keys()].map(key => key.split('/')[0]),
)) {
  const baselineKey = `${profile}/${baselineLabel}`;
  const baseline = summary[baselineKey];
  const baselineRuns = groups.get(baselineKey);
  if (!baseline) {
    continue;
  }
  for (const [key, values] of Object.entries(summary)) {
    if (!key.startsWith(`${profile}/`) || key === baselineKey) {
      continue;
    }
    const candidateRuns = groups.get(key);
    comparisons[`${key} vs ${baselineLabel}`] = Object.fromEntries(
      [
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
        metricComparison(metric, baseline, values, baselineRuns, candidateRuns),
      ]),
    );
  }
}

const output = {
  stage,
  generatedAt: new Date().toISOString(),
  summary,
  comparisons,
};
await writeFile(
  join(root, 'results', `${stage}-summary.json`),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output, null, 2));

function median(input) {
  if (!input.length) {
    return undefined;
  }
  const values = [...input].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

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
    typeof baseline[metric] !== 'number' ||
    baseline[metric] === 0 ||
    typeof candidate[metric] !== 'number'
  ) {
    return undefined;
  }
  const ratio = candidate[metric] / baseline[metric];
  const baselineByRepetition = new Map(
    baselineRuns?.map(run => [run.repetition, run[metric]]),
  );
  const pairedRatios = (candidateRuns ?? [])
    .map(run => {
      const baselineValue = baselineByRepetition.get(run.repetition);
      return typeof baselineValue === 'number' &&
        baselineValue !== 0 &&
        typeof run[metric] === 'number'
        ? run[metric] / baselineValue
        : undefined;
    })
    .filter(value => typeof value === 'number');
  const pairedRatio = median(pairedRatios);
  return {
    ratio,
    changePercent: (ratio - 1) * 100,
    pairedRatio,
    pairedChangePercent:
      pairedRatio === undefined ? undefined : (pairedRatio - 1) * 100,
  };
}
