import fs from 'node:fs';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const rawRoot = path.join(root, 'raw');
const priorRoot = path.join(root, '..', '1.0-to-1.8');
const priorAggregate = JSON.parse(
  fs.readFileSync(path.join(priorRoot, 'aggregate.json'), 'utf8'),
);

const runCount = 10;
const groups = [
  {
    id: 'product-pg',
    title: 'Postgres Sync, Replication, And Catch-up',
  },
  {
    id: 'product-zql',
    title: 'Local And Server Query Workloads',
  },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function geometricMean(values) {
  return Math.exp(
    values.reduce((sum, value) => sum + Math.log(value), 0) / values.length,
  );
}

function parseLog(file) {
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed.benchmarks)) {
      continue;
    }

    for (const benchmark of parsed.benchmarks) {
      rows.push({
        name: benchmark.name,
        median: benchmark.stats.median,
        unit: benchmark.unit,
        valueKind: benchmark.valueKind,
        metadata: benchmark.metadata,
      });
    }
  }

  if (rows.length === 0) {
    throw new Error(`No benchmark JSON found in ${file}`);
  }

  return rows;
}

function collectBaseline(group) {
  const out = new Map();
  for (let i = 1; i <= runCount; i++) {
    const runID = String(i).padStart(2, '0');
    const file = path.join(rawRoot, group.id, `baseline-${runID}.log`);
    if (!fs.existsSync(file)) {
      throw new Error(`Missing raw log ${file}`);
    }

    for (const row of parseLog(file)) {
      const existing = out.get(row.name) ?? {
        runs: [],
        unit: row.unit,
        valueKind: row.valueKind,
        metadata: row.metadata,
      };
      if (existing.unit !== row.unit || existing.valueKind !== row.valueKind) {
        throw new Error(`Inconsistent units for ${row.name} in ${file}`);
      }
      existing.runs.push(row.median);
      out.set(row.name, existing);
    }
  }
  return out;
}

function priorGroup(groupID) {
  const group = priorAggregate.results.find(result => result.id === groupID);
  if (!group) {
    throw new Error(`Missing prior aggregate group ${groupID}`);
  }
  return group;
}

function formatDuration(ns) {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} us`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

function formatValue(value, unit, valueKind) {
  if (unit === 'ns/MB' && valueKind === 'throughputAsNsPerOperation') {
    return `${(1_000_000_000 / value).toFixed(2)} MB/s`;
  }
  if (unit === 'ns') {
    return formatDuration(value);
  }
  return `${value.toFixed(2)} ${unit}`;
}

function displayName(name) {
  const names = {
    'postgres initial sync copy into replica':
      'Postgres initial sync/backfill payload',
    'postgres replication one large transaction payload MB':
      'Live Postgres replication, one large transaction',
    'postgres replication many medium transactions payload MB':
      'Live Postgres replication, many medium transactions',
    'postgres commit to local replica visibility latency':
      'Postgres commit-to-local-replica visibility latency',
    'reconnect catch-up from stored change stream backlog':
      'Reconnect/catch-up from stored ChangeStreamer backlog',
    'local client hydrate 5k issues with creators':
      'Local client query hydration, creators',
    'local client hydrate 5k issues with creators and comments':
      'Local client query hydration, creators and comments',
    'server initialize large SQLite-backed query with related rows':
      'Server large SQLite-backed query initialization',
    'new client initial load from existing local replica':
      'New client initial load from existing local replica',
    'large result materialization with related rows':
      'Large result materialization with related rows',
    'maintain sparse orderBy limit query cutoff 50 rows deep':
      'Sparse where() + orderBy() + limit(), cutoff 50',
    'maintain sparse orderBy limit query cutoff 10000 rows deep':
      'Sparse where() + orderBy() + limit(), cutoff 10,000',
    'maintain sparse orderBy limit query cutoff 50000 rows deep':
      'Sparse where() + orderBy() + limit(), cutoff 50,000',
    'maintain sparse orderBy limit query cutoff 90000 rows deep':
      'Sparse where() + orderBy() + limit(), cutoff 90,000',
    'maintain sparse orderBy limit query cutoff 100000 rows deep':
      'Sparse where() + orderBy() + limit(), cutoff 100,000',
  };
  return names[name] ?? name;
}

function compareGroup(group) {
  const baseline = collectBaseline(group);
  const prior = priorGroup(group.id);
  const priorRows = new Map(prior.rows.map(row => [row.name, row]));
  const rows = [...baseline.keys()]
    .filter(name => priorRows.has(name))
    .map(name => {
      const b = baseline.get(name);
      const priorRow = priorRows.get(name);
      if (b.runs.length !== runCount || priorRow.targetRuns.length !== runCount) {
        throw new Error(
          `${name} expected ${runCount} runs per ref, got ${b.runs.length}/${priorRow.targetRuns.length}`,
        );
      }
      const baselineMedian = median(b.runs);
      const targetMedian = median(priorRow.targetRuns);
      const ratio = baselineMedian / targetMedian;
      return {
        name,
        displayName: displayName(name),
        unit: b.unit,
        valueKind: b.valueKind,
        baseline: baselineMedian,
        target: targetMedian,
        ratio,
        baselineDisplay: formatValue(baselineMedian, b.unit, b.valueKind),
        targetDisplay: formatValue(targetMedian, b.unit, b.valueKind),
        baselineRuns: b.runs,
        targetRuns: priorRow.targetRuns,
        baselineMetadata: b.metadata,
        targetMetadata: priorRow.targetMetadata,
      };
    });

  const ratios = rows.map(row => row.ratio);
  return {
    id: group.id,
    title: group.title,
    comparableCount: rows.length,
    medianRatio: median(ratios),
    geometricMeanRatio: geometricMean(ratios),
    improvedOver5Percent: rows.filter(row => row.ratio > 1.05).length,
    regressedOver5Percent: rows.filter(row => row.ratio < 0.95).length,
    rows,
  };
}

const results = groups.map(compareGroup);
const allRows = results.flatMap(group =>
  group.rows.map(row => ({...row, group: group.title})),
);
const allRatios = allRows.map(row => row.ratio);
const largestImprovement = [...allRows].sort((a, b) => b.ratio - a.ratio)[0];
const rowsExcludingLargestImprovement = allRows.filter(
  row => row !== largestImprovement,
);
const ratiosExcludingLargestImprovement = rowsExcludingLargestImprovement.map(
  row => row.ratio,
);

const summary = {
  comparableCount: allRows.length,
  medianRatio: median(allRatios),
  geometricMeanRatio: geometricMean(allRatios),
  improvedOver5Percent: allRows.filter(row => row.ratio > 1.05).length,
  regressedOver5Percent: allRows.filter(row => row.ratio < 0.95).length,
  excludingLargestImprovement: {
    excludedGroup: largestImprovement.group,
    excludedName: largestImprovement.name,
    excludedRatio: largestImprovement.ratio,
    comparableCount: rowsExcludingLargestImprovement.length,
    medianRatio: median(ratiosExcludingLargestImprovement),
    geometricMeanRatio: geometricMean(ratiosExcludingLargestImprovement),
  },
};

const aggregate = {
  generatedAt: new Date().toISOString(),
  baseline: {
    ref: 'zero/v0.22.2025071101',
    sha: 'bef41d6de044cd3de5173c56df1329a19933e175',
    publishedAt: '2025-07-11T16:30:57.769Z',
  },
  target: priorAggregate.target,
  reusedTargetRunsFrom: '.releases/1.8/benchmarks/1.0-to-1.8/aggregate.json',
  runCountPerRef: runCount,
  aggregation:
    'median of each process-level benchmark median; raw duration and ns/MB values use baseline / target ratios, so >1 is faster in target',
  throughputDisplay:
    'ns/MB throughput metrics are displayed as decimal MB/s by converting with 1,000,000,000 / nsPerMB',
  summary,
  results,
};

fs.writeFileSync(
  path.join(root, 'aggregate.json'),
  `${JSON.stringify(aggregate, null, 2)}\n`,
);

function pushAggregateMarkdown(md) {
  md.push('# Zero 0.22 to 1.8 Product Benchmark Results');
  md.push('');
  md.push(
    '- Baseline: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`), published `2025-07-11T16:30:57.769Z`',
  );
  md.push(
    '- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)',
  );
  md.push('- Target runs reused from `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.json`');
  md.push('- Run count: 10 separate processes per ref per benchmark command');
  md.push('- Aggregation: median of process-level medians');
  md.push('- Ratio: raw `baseline / target`; values above `1.0` are faster in target');
  md.push('- Throughput display: `ns/MB` metrics are converted to decimal `MB/s`');
  md.push('');
  md.push('## Overall');
  md.push('');
  md.push(`- Comparable rows: ${summary.comparableCount}`);
  md.push(`- Median ratio: ${summary.medianRatio.toFixed(2)}x`);
  md.push(`- Geometric mean ratio: ${summary.geometricMeanRatio.toFixed(2)}x`);
  md.push(`- Improved by >5%: ${summary.improvedOver5Percent}`);
  md.push(`- Regressed by >5%: ${summary.regressedOver5Percent}`);
  md.push(
    `- Excluding largest improvement (${summary.excludingLargestImprovement.excludedName}): median ${summary.excludingLargestImprovement.medianRatio.toFixed(2)}x, geometric mean ${summary.excludingLargestImprovement.geometricMeanRatio.toFixed(2)}x`,
  );
  md.push('');

  for (const group of results) {
    md.push(`## ${group.title}`);
    md.push('');
    md.push(`- Comparable rows: ${group.comparableCount}`);
    md.push(`- Median ratio: ${group.medianRatio.toFixed(2)}x`);
    md.push(`- Geometric mean ratio: ${group.geometricMeanRatio.toFixed(2)}x`);
    md.push(`- Improved by >5%: ${group.improvedOver5Percent}`);
    md.push(`- Regressed by >5%: ${group.regressedOver5Percent}`);
    md.push('');
    md.push('| Benchmark | Zero 0.22 | Zero 1.8 | Ratio |');
    md.push('| --- | ---: | ---: | ---: |');
    for (const row of group.rows) {
      md.push(
        `| ${row.displayName} | ${row.baselineDisplay} | ${row.targetDisplay} | ${row.ratio.toFixed(2)}x |`,
      );
    }
    md.push('');
  }
}

const aggregateMd = [];
pushAggregateMarkdown(aggregateMd);
fs.writeFileSync(path.join(root, 'aggregate.md'), `${aggregateMd.join('\n')}\n`);

function threeWayRows() {
  const rows = [];
  for (const group of results) {
    const priorRows = new Map(priorGroup(group.id).rows.map(row => [row.name, row]));
    for (const row of group.rows) {
      const priorRow = priorRows.get(row.name);
      const zero022 = row.baseline;
      const zero10 = priorRow.baseline;
      const zero18 = priorRow.target;
      rows.push({
        group: group.title,
        name: row.name,
        displayName: row.displayName,
        unit: row.unit,
        valueKind: row.valueKind,
        zero022,
        zero10,
        zero18,
        zero022Display: formatValue(zero022, row.unit, row.valueKind),
        zero10Display: formatValue(zero10, row.unit, row.valueKind),
        zero18Display: formatValue(zero18, row.unit, row.valueKind),
        ratio1_8Vs0_22: zero022 / zero18,
        ratio1_8Vs1_0: zero10 / zero18,
        ratio1_0Vs0_22: zero022 / zero10,
      });
    }
  }
  return rows;
}

const threeWay = {
  generatedAt: aggregate.generatedAt,
  versions: {
    zero022: aggregate.baseline,
    zero10: priorAggregate.baseline,
    zero18: priorAggregate.target,
  },
  runCountPerRef: runCount,
  aggregation: 'median of process-level medians',
  rows: threeWayRows(),
};

fs.writeFileSync(
  path.join(root, 'three-way.json'),
  `${JSON.stringify(threeWay, null, 2)}\n`,
);

const threeWayMd = [];
threeWayMd.push('# Zero 0.22, 1.0, and 1.8 Product Benchmark Comparison');
threeWayMd.push('');
threeWayMd.push('- `Zero 0.22`: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`), published `2025-07-11T16:30:57.769Z`');
threeWayMd.push('- `Zero 1.0`: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)');
threeWayMd.push('- `Zero 1.8`: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)');
threeWayMd.push('- Values are median of 10 process-level medians per ref. Throughput rows are decimal `MB/s`; duration rows are lower-is-better.');
threeWayMd.push('- Ratios above `1.0` mean the newer version is faster.');
threeWayMd.push('');
threeWayMd.push('| Workload | Zero 0.22 | Zero 1.0 | Zero 1.8 | 1.8 vs 0.22 | 1.8 vs 1.0 | 1.0 vs 0.22 |');
threeWayMd.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const row of threeWay.rows) {
  threeWayMd.push(
    `| ${row.displayName} | ${row.zero022Display} | ${row.zero10Display} | ${row.zero18Display} | ${row.ratio1_8Vs0_22.toFixed(2)}x | ${row.ratio1_8Vs1_0.toFixed(2)}x | ${row.ratio1_0Vs0_22.toFixed(2)}x |`,
  );
}
threeWayMd.push('');

fs.writeFileSync(path.join(root, 'three-way.md'), `${threeWayMd.join('\n')}\n`);

console.log(JSON.stringify({aggregate, threeWay}, null, 2));
