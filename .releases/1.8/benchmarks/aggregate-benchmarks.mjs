import fs from 'node:fs';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const rawRoot = path.join(root, 'raw');

const groups = [
  {
    id: 'memory-fetch',
    title: 'In-Memory ZQL Fetch',
    unit: 'ns/iter',
    valueKind: 'duration',
  },
  {
    id: 'take-start-seek',
    title: 'Ordered Limit Boundary Fetch',
    unit: 'ns/iter',
    valueKind: 'duration',
  },
  {
    id: 'storer-pg',
    title: 'CDC Storer Throughput',
    unit: 'ns/MB',
    valueKind: 'throughputAsNsPerOperation',
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
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rows = [];
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
      });
    }
  }
  return rows;
}

function collectGroup(group) {
  const out = {baseline: new Map(), target: new Map()};
  for (const ref of ['baseline', 'target']) {
    for (let i = 1; i <= 10; i++) {
      const file = path.join(rawRoot, group.id, `${ref}-${i}.log`);
      const rows = parseLog(file);
      if (rows.length === 0) {
        throw new Error(`No benchmark JSON found in ${file}`);
      }
      for (const row of rows) {
        const values = out[ref].get(row.name) ?? [];
        values.push(row.median);
        out[ref].set(row.name, values);
      }
    }
  }
  return out;
}

function shortName(name) {
  return name.replace(/^src\/[^>]+ > /, '');
}

function formatDuration(ns) {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} us`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

function formatValue(value, group) {
  if (group.valueKind === 'throughputAsNsPerOperation') {
    return `${(1_000_000_000 / value).toFixed(2)} MB/s`;
  }
  return formatDuration(value);
}

const results = [];

for (const group of groups) {
  const collected = collectGroup(group);
  const names = [...collected.baseline.keys()].filter(name =>
    collected.target.has(name),
  );
  if (names.length === 0) {
    throw new Error(`No comparable benchmarks for ${group.id}`);
  }

  const rows = names.map(name => {
    const baselineRuns = collected.baseline.get(name);
    const targetRuns = collected.target.get(name);
    if (baselineRuns.length !== 10 || targetRuns.length !== 10) {
      throw new Error(
        `${name} expected 10 runs per ref, got ${baselineRuns.length}/${targetRuns.length}`,
      );
    }
    const baseline = median(baselineRuns);
    const target = median(targetRuns);
    const ratio = baseline / target;
    return {
      name,
      shortName: shortName(name),
      unit: group.unit,
      baseline,
      target,
      ratio,
      baselineDisplay: formatValue(baseline, group),
      targetDisplay: formatValue(target, group),
      baselineRuns,
      targetRuns,
    };
  });

  results.push({
    id: group.id,
    title: group.title,
    unit: group.unit,
    valueKind: group.valueKind,
    comparableCount: rows.length,
    medianRatio: median(rows.map(row => row.ratio)),
    geometricMeanRatio: geometricMean(rows.map(row => row.ratio)),
    rows,
  });
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  baseline: {
    ref: 'zero/v1.7.0',
    sha: '6863de5f00a3c1e7dc09c83ea3263dec4a94ebee',
  },
  target: {
    ref: 'maint/zero/v1.8',
    sha: 'cdc02598f137ab4e071878f5674fdc716dbbc69d',
  },
  runCountPerRef: 10,
  aggregation:
    'median of each process-level benchmark median; ratios are baseline / target, so >1 is faster in target',
  results,
};

fs.writeFileSync(
  path.join(root, 'aggregate.json'),
  `${JSON.stringify(aggregate, null, 2)}\n`,
);

const md = [];
md.push('# Zero 1.8 Benchmark Results');
md.push('');
md.push(
  '- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)',
);
md.push(
  '- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)',
);
md.push('- Run count: 10 separate processes per ref per benchmark command');
md.push('- Aggregation: median of process-level medians');
md.push(
  '- Ratio: `baseline / target`; values above `1.0` are faster in target',
);
md.push('');

for (const group of results) {
  md.push(`## ${group.title}`);
  md.push('');
  md.push(`- Comparable rows: ${group.comparableCount}`);
  md.push(`- Median ratio: ${group.medianRatio.toFixed(2)}x`);
  md.push(`- Geometric mean ratio: ${group.geometricMeanRatio.toFixed(2)}x`);
  md.push('');
  md.push('| Benchmark | Zero 1.7 | Zero 1.8 | Ratio |');
  md.push('| --- | ---: | ---: | ---: |');
  for (const row of group.rows) {
    md.push(
      `| ${row.shortName} | ${row.baselineDisplay} | ${row.targetDisplay} | ${row.ratio.toFixed(2)}x |`,
    );
  }
  md.push('');
}

fs.writeFileSync(path.join(root, 'aggregate.md'), `${md.join('\n')}\n`);

console.log(JSON.stringify(aggregate, null, 2));
