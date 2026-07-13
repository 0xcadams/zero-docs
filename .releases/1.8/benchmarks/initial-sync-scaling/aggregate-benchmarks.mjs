import fs from 'node:fs';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const rawRoot = path.join(root, 'raw');
const runCount = 10;

const sizes = [
  {id: '40mb', label: '40 MB', rows: 20_000},
  {id: '400mb', label: '400 MB', rows: 200_000},
  {id: '1200mb', label: '1.2 GB', rows: 600_000},
];

const configs = [
  {id: 'zero-0.22', label: 'Zero 0.22', format: 'text'},
  {id: 'zero-1.0', label: 'Zero 1.0', format: 'text'},
  {id: 'zero-1.8-binary', label: 'Zero 1.8 binary', format: 'binary'},
  {id: 'zero-1.8-text', label: 'Zero 1.8 text', format: 'text'},
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const avg = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
      (values.length - 1),
  );
}

function parseLog(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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
    const benchmark = parsed.benchmarks?.find(
      row => row.name === 'postgres initial sync copy into replica',
    );
    if (benchmark) {
      const nsPerMB = benchmark.stats.median;
      const payloadMB = benchmark.metadata.payloadMB;
      return {
        nsPerMB,
        payloadMB,
        throughputMBps: 1_000_000_000 / nsPerMB,
        elapsedSeconds: (nsPerMB * payloadMB) / 1_000_000_000,
        metadata: benchmark.metadata,
      };
    }
  }
  throw new Error(`No initial-sync benchmark JSON found in ${file}`);
}

function collect() {
  const results = [];
  for (const size of sizes) {
    for (const config of configs) {
      const runs = [];
      for (let i = 1; i <= runCount; i++) {
        const runID = String(i).padStart(2, '0');
        const file = path.join(
          rawRoot,
          size.id,
          `${config.id}-${runID}.log`,
        );
        if (!fs.existsSync(file)) {
          throw new Error(`Missing raw log ${file}`);
        }
        runs.push(parseLog(file));
      }

      const payloads = runs.map(run => run.payloadMB);
      if (new Set(payloads).size !== 1) {
        throw new Error(`Inconsistent payload sizes for ${size.id}/${config.id}`);
      }
      const throughput = runs.map(run => run.throughputMBps);
      const elapsed = runs.map(run => run.elapsedSeconds);
      const throughputMean = mean(throughput);
      results.push({
        size: size.id,
        sizeLabel: size.label,
        rows: size.rows,
        config: config.id,
        configLabel: config.label,
        copyFormat: config.format,
        payloadMB: payloads[0],
        throughputMedianMBps: median(throughput),
        throughputMeanMBps: throughputMean,
        throughputSDMBps: standardDeviation(throughput),
        throughputCV: standardDeviation(throughput) / throughputMean,
        throughputMinMBps: Math.min(...throughput),
        throughputMaxMBps: Math.max(...throughput),
        elapsedMedianSeconds: median(elapsed),
        throughputRunsMBps: throughput,
        elapsedRunsSeconds: elapsed,
      });
    }
  }
  return results;
}

function bootstrapMedianCI(values, seedStart) {
  let seed = seedStart >>> 0;
  const random = () => {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  const samples = [];
  for (let i = 0; i < 50_000; i++) {
    const sample = Array.from(
      {length: values.length},
      () => values[Math.floor(random() * values.length)],
    );
    samples.push(median(sample));
  }
  samples.sort((a, b) => a - b);
  return {
    low: samples[Math.floor(samples.length * 0.025)],
    high: samples[Math.floor(samples.length * 0.975)],
  };
}

function pairedComparison(results, sizeID, newerID, olderID, seed) {
  const newer = results.find(
    result => result.size === sizeID && result.config === newerID,
  );
  const older = results.find(
    result => result.size === sizeID && result.config === olderID,
  );
  const ratios = newer.throughputRunsMBps.map(
    (value, index) => value / older.throughputRunsMBps[index],
  );
  return {
    size: sizeID,
    newer: newerID,
    older: olderID,
    medianRatio: median(ratios),
    bootstrap95: bootstrapMedianCI(ratios, seed),
    pairedRatios: ratios,
  };
}

function linearFit(points) {
  const xMean = mean(points.map(point => point.x));
  const yMean = mean(points.map(point => point.y));
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - xMean) * (point.y - yMean),
    0,
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.x - xMean) ** 2,
    0,
  );
  const slopeSecondsPerMB = numerator / denominator;
  const interceptSeconds = yMean - slopeSecondsPerMB * xMean;
  const totalSS = points.reduce(
    (sum, point) => sum + (point.y - yMean) ** 2,
    0,
  );
  const residualSS = points.reduce(
    (sum, point) =>
      sum +
      (point.y - (interceptSeconds + slopeSecondsPerMB * point.x)) ** 2,
    0,
  );
  return {
    interceptSeconds,
    slopeSecondsPerMB,
    sustainedThroughputMBps: 1 / slopeSecondsPerMB,
    rSquared: 1 - residualSS / totalSS,
  };
}

const results = collect();
const comparisons = [];
let seed = 100;
for (const size of sizes) {
  comparisons.push(
    pairedComparison(results, size.id, 'zero-1.0', 'zero-0.22', seed++),
    pairedComparison(
      results,
      size.id,
      'zero-1.8-binary',
      'zero-0.22',
      seed++,
    ),
    pairedComparison(
      results,
      size.id,
      'zero-1.8-binary',
      'zero-1.0',
      seed++,
    ),
    pairedComparison(
      results,
      size.id,
      'zero-1.8-binary',
      'zero-1.8-text',
      seed++,
    ),
  );
}

const fits = configs.map(config => {
  const configResults = results.filter(result => result.config === config.id);
  return {
    config: config.id,
    configLabel: config.label,
    ...linearFit(
      configResults.flatMap(result =>
        result.elapsedRunsSeconds.map(elapsed => ({
          x: result.payloadMB,
          y: elapsed,
        })),
      ),
    ),
  };
});

function piecewiseEstimate(configID) {
  const small = results.find(
    result => result.size === '40mb' && result.config === configID,
  );
  const medium = results.find(
    result => result.size === '400mb' && result.config === configID,
  );
  const large = results.find(
    result => result.size === '1200mb' && result.config === configID,
  );
  const smallToMediumSlope =
    (medium.elapsedMedianSeconds - small.elapsedMedianSeconds) /
    (medium.payloadMB - small.payloadMB);
  const mediumToLargeSlope =
    (large.elapsedMedianSeconds - medium.elapsedMedianSeconds) /
    (large.payloadMB - medium.payloadMB);
  return {
    config: configID,
    configLabel: configs.find(config => config.id === configID).label,
    estimatedFixedCostSeconds:
      small.elapsedMedianSeconds - smallToMediumSlope * small.payloadMB,
    smallToMediumMarginalThroughputMBps: 1 / smallToMediumSlope,
    mediumToLargeMarginalThroughputMBps: 1 / mediumToLargeSlope,
  };
}

const piecewiseEstimates = configs.map(config => piecewiseEstimate(config.id));

const aggregate = {
  generatedAt: new Date().toISOString(),
  refs: {
    zero022: {
      ref: 'zero/v0.22.2025071101',
      sha: 'bef41d6de044cd3de5173c56df1329a19933e175',
    },
    zero10: {
      ref: 'zero/v1.0.0',
      sha: '5a5ea6b786d126fb12f34b1b81a846b8b00a754b',
    },
    zero18: {
      ref: 'maint/zero/v1.8',
      sha: 'cdc02598f137ab4e071878f5674fdc716dbbc69d',
    },
  },
  runCountPerConfigurationAndSize: runCount,
  runOrderPerRound: [
    'zero-0.22',
    'zero-1.0',
    'zero-1.8-binary',
    'zero-1.8-text',
  ],
  results,
  pairedComparisons: comparisons,
  linearFits: fits,
  piecewiseEstimates,
};

fs.writeFileSync(
  path.join(root, 'aggregate.json'),
  `${JSON.stringify(aggregate, null, 2)}\n`,
);

function result(sizeID, configID) {
  return results.find(
    row => row.size === sizeID && row.config === configID,
  );
}

function comparison(sizeID, newerID, olderID) {
  return comparisons.find(
    row =>
      row.size === sizeID &&
      row.newer === newerID &&
      row.older === olderID,
  );
}

function formatCell(row) {
  return `${row.throughputMedianMBps.toFixed(1)} MB/s (${row.elapsedMedianSeconds.toFixed(2)} s)`;
}

function formatRatio(row) {
  return `${row.medianRatio.toFixed(2)}x [${row.bootstrap95.low.toFixed(2)}, ${row.bootstrap95.high.toFixed(2)}]`;
}

const md = [];
md.push('# Focused Initial Sync Scaling Results');
md.push('');
md.push('- 10 sequential, paired rounds per configuration and size');
md.push('- Four table-copy workers');
md.push('- Throughput is deterministic fixture payload in decimal MB/s');
md.push('- Parentheses show median elapsed initial-sync time');
md.push('- Ratios above `1.0` mean the newer/first-named configuration is faster');
md.push('- Brackets show paired-round bootstrap 95% intervals for the median ratio');
md.push('');
md.push('| Payload | Zero 0.22 text | Zero 1.0 text | Zero 1.8 binary | Zero 1.8 text |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const size of sizes) {
  md.push(
    `| ${size.label} | ${formatCell(result(size.id, 'zero-0.22'))} | ${formatCell(result(size.id, 'zero-1.0'))} | ${formatCell(result(size.id, 'zero-1.8-binary'))} | ${formatCell(result(size.id, 'zero-1.8-text'))} |`,
  );
}
md.push('');
md.push('## Paired Speedups');
md.push('');
md.push('| Payload | 1.0 vs 0.22 | 1.8 binary vs 0.22 | 1.8 binary vs 1.0 | 1.8 binary vs text |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const size of sizes) {
  md.push(
    `| ${size.label} | ${formatRatio(comparison(size.id, 'zero-1.0', 'zero-0.22'))} | ${formatRatio(comparison(size.id, 'zero-1.8-binary', 'zero-0.22'))} | ${formatRatio(comparison(size.id, 'zero-1.8-binary', 'zero-1.0'))} | ${formatRatio(comparison(size.id, 'zero-1.8-binary', 'zero-1.8-text'))} |`,
  );
}
md.push('');
md.push('## Piecewise Scaling');
md.push('');
md.push(
  'The 40-400 MB segment estimates fixed startup cost plus unconstrained marginal throughput. The 400 MB-1.2 GB segment shows throughput after the local workload enters a slower scaling regime.',
);
md.push('');
md.push('| Configuration | Estimated Fixed Cost | 40-400 MB Marginal Throughput | 400 MB-1.2 GB Marginal Throughput |');
md.push('| --- | ---: | ---: | ---: |');
for (const estimate of piecewiseEstimates) {
  md.push(
    `| ${estimate.configLabel} | ${estimate.estimatedFixedCostSeconds.toFixed(3)} s | ${estimate.smallToMediumMarginalThroughputMBps.toFixed(1)} MB/s | ${estimate.mediumToLargeMarginalThroughputMBps.toFixed(1)} MB/s |`,
  );
}
md.push('');
md.push(
  'A single linear fit across all three sizes has a negative intercept for every configuration, so it is retained in `aggregate.json` only as a diagnostic and must not be interpreted as fixed startup cost.',
);
md.push('');
md.push('## Dispersion');
md.push('');
md.push('| Payload | Configuration | Median | Min-Max | CV |');
md.push('| --- | --- | ---: | ---: | ---: |');
for (const row of results) {
  md.push(
    `| ${row.sizeLabel} | ${row.configLabel} | ${row.throughputMedianMBps.toFixed(1)} MB/s | ${row.throughputMinMBps.toFixed(1)}-${row.throughputMaxMBps.toFixed(1)} MB/s | ${(row.throughputCV * 100).toFixed(1)}% |`,
  );
}
md.push('');

fs.writeFileSync(path.join(root, 'results.md'), `${md.join('\n')}\n`);

console.log(JSON.stringify(aggregate, null, 2));
