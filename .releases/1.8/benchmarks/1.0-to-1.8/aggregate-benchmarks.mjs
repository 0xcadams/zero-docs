import fs from 'node:fs';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const rawRoot = path.join(root, 'raw');

const runCount = 10;
const baselineLabel = 'Zero 1.0';
const targetLabel = 'Zero 1.8';

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
        avg: benchmark.stats.avg,
        min: benchmark.stats.min,
        max: benchmark.stats.max,
        p75: benchmark.stats.p75,
        p99: benchmark.stats.p99,
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

function collectGroup(group) {
  const out = {baseline: new Map(), target: new Map()};

  for (const ref of ['baseline', 'target']) {
    for (let i = 1; i <= runCount; i++) {
      const runID = String(i).padStart(2, '0');
      const file = path.join(rawRoot, group.id, `${ref}-${runID}.log`);
      if (!fs.existsSync(file)) {
        throw new Error(`Missing raw log ${file}`);
      }

      for (const row of parseLog(file)) {
        const existing = out[ref].get(row.name) ?? {
          runs: [],
          unit: row.unit,
          valueKind: row.valueKind,
          metadata: row.metadata,
        };

        if (existing.unit !== row.unit || existing.valueKind !== row.valueKind) {
          throw new Error(`Inconsistent units for ${row.name} in ${file}`);
        }

        existing.runs.push(row.median);
        out[ref].set(row.name, existing);
      }
    }
  }

  return out;
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

function ratioLabel(row) {
  return `${row.ratio.toFixed(2)}x`;
}

function compareGroup(group) {
  const collected = collectGroup(group);
  const names = [...collected.baseline.keys()].filter(name =>
    collected.target.has(name),
  );

  if (names.length === 0) {
    throw new Error(`No comparable benchmarks for ${group.id}`);
  }

  const rows = names.map(name => {
    const baseline = collected.baseline.get(name);
    const target = collected.target.get(name);
    if (baseline.runs.length !== runCount || target.runs.length !== runCount) {
      throw new Error(
        `${name} expected ${runCount} runs per ref, got ${baseline.runs.length}/${target.runs.length}`,
      );
    }

    const baselineMedian = median(baseline.runs);
    const targetMedian = median(target.runs);
    const ratio = baselineMedian / targetMedian;

    return {
      name,
      unit: baseline.unit,
      valueKind: baseline.valueKind,
      baseline: baselineMedian,
      target: targetMedian,
      ratio,
      baselineDisplay: formatValue(
        baselineMedian,
        baseline.unit,
        baseline.valueKind,
      ),
      targetDisplay: formatValue(targetMedian, target.unit, target.valueKind),
      baselineRuns: baseline.runs,
      targetRuns: target.runs,
      baselineMetadata: baseline.metadata,
      targetMetadata: target.metadata,
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
    improvedOver5Percent: rowsExcludingLargestImprovement.filter(
      row => row.ratio > 1.05,
    ).length,
    regressedOver5Percent: rowsExcludingLargestImprovement.filter(
      row => row.ratio < 0.95,
    ).length,
  },
  topImprovements: [...allRows]
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5)
    .map(({group, name, baselineDisplay, targetDisplay, ratio}) => ({
      group,
      name,
      baselineDisplay,
      targetDisplay,
      ratio,
    })),
  topRegressions: [...allRows]
    .filter(row => row.ratio < 1)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 5)
    .map(({group, name, baselineDisplay, targetDisplay, ratio}) => ({
      group,
      name,
      baselineDisplay,
      targetDisplay,
      ratio,
    })),
};

const aggregate = {
  generatedAt: new Date().toISOString(),
  baseline: {
    ref: 'zero/v1.0.0',
    sha: '5a5ea6b786d126fb12f34b1b81a846b8b00a754b',
  },
  target: {
    ref: 'maint/zero/v1.8',
    sha: 'cdc02598f137ab4e071878f5674fdc716dbbc69d',
  },
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

const md = [];
md.push('# Zero 1.0 to 1.8 Product Benchmark Results');
md.push('');
md.push(
  '- Baseline: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)',
);
md.push(
  '- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)',
);
md.push('- Run count: 10 separate processes per ref per benchmark command');
md.push('- Aggregation: median of process-level medians');
md.push(
  '- Ratio: raw `baseline / target`; values above `1.0` are faster in target',
);
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
md.push('### Top Improvements');
md.push('');
md.push(`| Group | Benchmark | ${baselineLabel} | ${targetLabel} | Ratio |`);
md.push('| --- | --- | ---: | ---: | ---: |');
for (const row of summary.topImprovements) {
  md.push(
    `| ${row.group} | ${row.name} | ${row.baselineDisplay} | ${row.targetDisplay} | ${row.ratio.toFixed(2)}x |`,
  );
}
md.push('');
md.push('### Top Regressions');
md.push('');
if (summary.topRegressions.length === 0) {
  md.push('No benchmark rows regressed versus baseline.');
  md.push('');
} else {
  md.push(`| Group | Benchmark | ${baselineLabel} | ${targetLabel} | Ratio |`);
  md.push('| --- | --- | ---: | ---: | ---: |');
  for (const row of summary.topRegressions) {
    md.push(
      `| ${row.group} | ${row.name} | ${row.baselineDisplay} | ${row.targetDisplay} | ${row.ratio.toFixed(2)}x |`,
    );
  }
  md.push('');
}

for (const group of results) {
  md.push(`## ${group.title}`);
  md.push('');
  md.push(`- Comparable rows: ${group.comparableCount}`);
  md.push(`- Median ratio: ${group.medianRatio.toFixed(2)}x`);
  md.push(`- Geometric mean ratio: ${group.geometricMeanRatio.toFixed(2)}x`);
  md.push(`- Improved by >5%: ${group.improvedOver5Percent}`);
  md.push(`- Regressed by >5%: ${group.regressedOver5Percent}`);
  md.push('');
  md.push(`| Benchmark | ${baselineLabel} | ${targetLabel} | Ratio |`);
  md.push('| --- | ---: | ---: | ---: |');
  for (const row of group.rows) {
    md.push(
      `| ${row.name} | ${row.baselineDisplay} | ${row.targetDisplay} | ${ratioLabel(row)} |`,
    );
  }
  md.push('');
}

fs.writeFileSync(path.join(root, 'aggregate.md'), `${md.join('\n')}\n`);

console.log(JSON.stringify(aggregate, null, 2));
