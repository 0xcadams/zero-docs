const DEFAULT_BOOTSTRAP_RESAMPLES = 20_000;
const DEFAULT_MINIMUM_PAIRED_BLOCKS = 5;
const CONDITION_KEYS = [
  'condition',
  'conditions',
  'constraints',
  'postgresTopology',
];

export function reconcileArtifacts(
  manifest,
  runs,
  {canonicalArtifact = true} = {},
) {
  if (!manifest || !Array.isArray(manifest.runs)) {
    throw new Error('Manifest must declare a runs array');
  }
  if (!Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error('Manifest must have a valid generatedAt timestamp');
  }

  const blocks = validateManifestBlocks(manifest);
  const expectedByID = new Map();
  for (const runConfig of manifest.runs) {
    const id = runID(runConfig);
    if (expectedByID.has(id)) {
      throw new Error(`Manifest declares duplicate run ${id}`);
    }
    expectedByID.set(id, runConfig);
  }

  const actualByID = new Map();
  const invalid = [];
  for (const run of runs) {
    const id = run?.meta?.id;
    if (typeof id !== 'string') {
      invalid.push(`${run?.file ?? '<unknown>'}: missing run metadata id`);
      continue;
    }
    if (actualByID.has(id)) {
      invalid.push(
        `duplicate run ${id} in ${actualByID.get(id).file} and ${run.file}`,
      );
      continue;
    }
    actualByID.set(id, run);
  }

  const missing = [...expectedByID.keys()].filter(id => !actualByID.has(id));
  const extra = [...actualByID.keys()].filter(id => !expectedByID.has(id));
  for (const [id, expected] of expectedByID) {
    const run = actualByID.get(id);
    if (!run) {
      continue;
    }
    const actualRunConfig = {
      ...run.meta.runConfig,
      ...(run.meta.constraints === undefined
        ? {}
        : {constraints: run.meta.constraints}),
    };
    if (stableStringify(actualRunConfig) !== stableStringify(expected)) {
      invalid.push(`${id}: runConfig does not exactly match the manifest`);
    }
    const startedAt = Date.parse(run.meta.startedAt);
    if (!Number.isFinite(startedAt)) {
      invalid.push(`${id}: missing or invalid startedAt timestamp`);
    } else if (startedAt < Date.parse(manifest.generatedAt)) {
      invalid.push(`${id}: stale run predates the manifest`);
    }
    if (run.result?.runLabel !== id) {
      invalid.push(`${id}: result runLabel does not match run metadata`);
    }
    if (run.result?.profile !== expected.profile) {
      invalid.push(`${id}: result profile does not match the manifest`);
    }
  }

  if (missing.length || extra.length || invalid.length) {
    throw new Error(
      [
        missing.length ? `missing runs: ${missing.join(', ')}` : undefined,
        extra.length ? `extra runs: ${extra.join(', ')}` : undefined,
        ...invalid,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }

  const analysisPlan = manifest.analysisPlan;
  if (
    analysisPlan?.plannedSampleCount !== undefined &&
    (!Number.isInteger(analysisPlan.plannedSampleCount) ||
      analysisPlan.plannedSampleCount < 1)
  ) {
    throw new Error(
      'analysisPlan.plannedSampleCount must be a positive integer',
    );
  }
  if (
    analysisPlan?.minimumPairedBlocks !== undefined &&
    (!Number.isInteger(analysisPlan.minimumPairedBlocks) ||
      analysisPlan.minimumPairedBlocks < 1)
  ) {
    throw new Error(
      'analysisPlan.minimumPairedBlocks must be a positive integer',
    );
  }
  if (
    analysisPlan?.bootstrapResamples !== undefined &&
    (!Number.isInteger(analysisPlan.bootstrapResamples) ||
      analysisPlan.bootstrapResamples < 1)
  ) {
    throw new Error(
      'analysisPlan.bootstrapResamples must be a positive integer',
    );
  }
  const explicitlyPlanned =
    canonicalArtifact &&
    analysisPlan !== undefined &&
    Number.isInteger(analysisPlan.plannedSampleCount) &&
    analysisPlan.plannedSampleCount > 0;
  const plannedSampleCount = explicitlyPlanned
    ? analysisPlan.plannedSampleCount
    : manifest.runs.length;
  if (plannedSampleCount < manifest.runs.length) {
    throw new Error(
      `Manifest has ${manifest.runs.length} runs but plannedSampleCount is ${plannedSampleCount}`,
    );
  }

  return {
    status: 'complete',
    expectedRunCount: manifest.runs.length,
    actualRunCount: runs.length,
    plannedSampleCount,
    plannedSampleCountReached: runs.length === plannedSampleCount,
    canonicalArtifact,
    explicitlyPlanned,
    classification: explicitlyPlanned
      ? runs.length === plannedSampleCount
        ? 'confirmatory-eligible'
        : 'incomplete'
      : 'exploratory-noncanonical',
    classificationReason: explicitlyPlanned
      ? runs.length === plannedSampleCount
        ? 'The manifest contains a predeclared fixed sample count.'
        : 'The predeclared fixed sample count has not been reached.'
      : canonicalArtifact
        ? 'Manifest has no explicit analysisPlan.plannedSampleCount.'
        : 'The artifact set is explicitly noncanonical.',
    minimumPairedBlocks:
      analysisPlan?.minimumPairedBlocks ?? DEFAULT_MINIMUM_PAIRED_BLOCKS,
    bootstrapResamples: Math.max(
      10_000,
      analysisPlan?.bootstrapResamples ?? DEFAULT_BOOTSTRAP_RESAMPLES,
    ),
    conditions: blocks.conditions,
  };
}

export function validateManifestBlocks(manifest) {
  const conditions = new Map();
  const seenDefinitions = new Map();

  for (const [manifestIndex, runConfig] of manifest.runs.entries()) {
    if (
      !Number.isInteger(runConfig?.repetition) ||
      runConfig.repetition < 1 ||
      typeof runConfig.profile !== 'string'
    ) {
      throw new Error(`Invalid manifest run at index ${manifestIndex}`);
    }
    const arm = treatmentLabel(runConfig);
    const condition = conditionDescriptor(runConfig, manifest);
    const conditionKey = stableStringify(condition);
    const definitionKey = `${conditionKey}\u0000${arm}`;
    const definition = stableStringify(
      Object.fromEntries(
        Object.entries(runConfig).filter(([key]) => key !== 'repetition'),
      ),
    );
    if (
      seenDefinitions.has(definitionKey) &&
      seenDefinitions.get(definitionKey) !== definition
    ) {
      throw new Error(
        `Treatment ${arm} changes configuration within condition ${conditionKey}`,
      );
    }
    seenDefinitions.set(definitionKey, definition);

    const entry = conditions.get(conditionKey) ?? {
      key: conditionKey,
      condition,
      arms: new Set(),
      blocks: new Map(),
    };
    entry.arms.add(arm);
    const block = entry.blocks.get(runConfig.repetition) ?? [];
    block.push({
      id: runID(runConfig),
      arm,
      manifestIndex,
      position: block.length + 1,
      repetition: runConfig.repetition,
    });
    entry.blocks.set(runConfig.repetition, block);
    conditions.set(conditionKey, entry);
  }

  const output = [];
  for (const entry of conditions.values()) {
    const arms = [...entry.arms].sort();
    const repetitions = [...entry.blocks.keys()].sort((a, b) => a - b);
    const expectedRepetitions = Array.from(
      {length: repetitions.at(-1) ?? 0},
      (_, index) => index + 1,
    );
    if (stableStringify(repetitions) !== stableStringify(expectedRepetitions)) {
      throw new Error(
        `Condition ${entry.key} has non-contiguous blocks ${repetitions.join(', ')}`,
      );
    }
    for (const repetition of repetitions) {
      const block = entry.blocks.get(repetition);
      const blockArms = block.map(run => run.arm).sort();
      if (stableStringify(blockArms) !== stableStringify(arms)) {
        throw new Error(
          `Incomplete or unbalanced block ${repetition} for condition ${entry.key}: expected ${arms.join(', ')}, got ${blockArms.join(', ')}`,
        );
      }
    }
    output.push({
      key: entry.key,
      condition: entry.condition,
      arms,
      blockCount: repetitions.length,
      blocks: repetitions.map(repetition => ({
        repetition,
        runs: entry.blocks.get(repetition),
      })),
    });
  }
  return {conditions: output};
}

export function analyzePairedRatios({
  id,
  pairs,
  reconciliation,
  plannedBlocks,
}) {
  if (!pairs.length) {
    throw new Error(`Comparison ${id} has no paired blocks`);
  }
  for (const pair of pairs) {
    if (
      !(pair.baselineValue > 0) ||
      !(pair.candidateValue > 0) ||
      !Number.isFinite(pair.baselineValue) ||
      !Number.isFinite(pair.candidateValue)
    ) {
      throw new Error(`Comparison ${id} has a non-positive or invalid value`);
    }
  }

  const pairedRatios = pairs.map(pair => {
    const ratio = pair.candidateValue / pair.baselineValue;
    return {...pair, ratio, logRatio: Math.log(ratio)};
  });
  const ratios = pairedRatios.map(pair => pair.ratio);
  const logRatios = pairedRatios.map(pair => pair.logRatio);
  const medianRatio = median(ratios);
  const bootstrap = pairedBootstrapCI(
    logRatios,
    reconciliation.bootstrapResamples,
    hashString(id),
  );
  const after = pairedRatios.filter(
    pair => pair.order === 'candidate-after-baseline',
  );
  const before = pairedRatios.filter(
    pair => pair.order === 'candidate-before-baseline',
  );
  const twoArmDesign = pairedRatios.every(pair => (pair.blockSize ?? 2) === 2);
  const orderCoverageAdequate =
    after.length > 0 &&
    before.length > 0 &&
    (!twoArmDesign || Math.abs(after.length - before.length) <= 1);
  const prerequisites = {
    artifactReconciliationComplete: reconciliation.status === 'complete',
    analysisPlanDeclared: reconciliation.explicitlyPlanned,
    plannedSampleCountReached: reconciliation.plannedSampleCountReached,
    completePairedBlocks: pairs.length === plannedBlocks,
    minimumPairedBlocksReached:
      pairs.length >= reconciliation.minimumPairedBlocks,
    orderCoverageAdequate,
  };
  const prerequisitesMet = Object.values(prerequisites).every(Boolean);
  const performanceGainPass =
    prerequisitesMet && medianRatio <= 0.95 && bootstrap.ratio.upper < 1;
  const noRegressionPass =
    prerequisitesMet && medianRatio <= 1.02 && bootstrap.ratio.upper < 1.03;
  const confidentRegression =
    prerequisitesMet && medianRatio > 1.02 && bootstrap.ratio.lower > 1;
  const status = !prerequisitesMet
    ? 'inconclusive'
    : performanceGainPass
      ? 'performance-gain'
      : noRegressionPass
        ? 'no-regression'
        : confidentRegression
          ? 'regression'
          : 'inconclusive';

  return {
    experimentalUnit: 'independent complete block',
    pairedRatios,
    estimates: {
      n: ratios.length,
      medianRatio,
      medianChangePercent: (medianRatio - 1) * 100,
      madRatio: median(ratios.map(ratio => Math.abs(ratio - medianRatio))),
      geometricMeanRatio: Math.exp(mean(logRatios)),
      geometricMeanChangePercent: (Math.exp(mean(logRatios)) - 1) * 100,
    },
    bootstrap95CI: bootstrap,
    orderEffect: orderEffect(after, before),
    gates: {
      prerequisites,
      prerequisitesMet,
      performanceGain: {
        pointGainAtLeastPercent: 5,
        ciUpperBelowRatio: 1,
        pass: prerequisitesMet ? performanceGainPass : null,
      },
      noRegression: {
        medianSlowdownAtMostPercent: 2,
        ciUpperBelowRatio: 1.03,
        pass: prerequisitesMet ? noRegressionPass : null,
      },
    },
    status,
    statusReason: statusReason(status, prerequisites),
  };
}

export function conditionDescriptor(runConfig, manifest = {}) {
  const condition = {profile: runConfig.profile};
  for (const key of CONDITION_KEYS) {
    if (runConfig[key] !== undefined) {
      condition[key] = runConfig[key];
    }
  }
  if (manifest.platform !== undefined) {
    condition.platform = manifest.platform;
  }
  if (manifest.environment !== undefined) {
    condition.environment = manifest.environment;
  }
  if (manifest.conditions !== undefined) {
    condition.manifestConditions = manifest.conditions;
  }
  return condition;
}

export function treatmentLabel(runConfig) {
  const label = runConfig?.label ?? runConfig?.worktree;
  if (typeof label !== 'string' || !label) {
    throw new Error('Every manifest run must have a label or worktree');
  }
  return label;
}

export function runID(runConfig) {
  return `${slug(runConfig.profile)}-${slug(treatmentLabel(runConfig))}-r${runConfig.repetition}`;
}

export function primaryRunMetric(result) {
  return result.samples
    ? median(result.samples.map(sample => sample.wallMs))
    : result.timing?.outerMs;
}

export function median(input) {
  if (!input.length) {
    return undefined;
  }
  const values = [...input].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function pairedBootstrapCI(logRatios, resamples, seed) {
  const random = xorshift32(seed || 1);
  const estimates = Array.from({length: resamples});
  for (let sample = 0; sample < resamples; sample++) {
    let total = 0;
    for (let index = 0; index < logRatios.length; index++) {
      total += logRatios[Math.floor(random() * logRatios.length)];
    }
    estimates[sample] = total / logRatios.length;
  }
  estimates.sort((a, b) => a - b);
  const lower = percentile(estimates, 0.025);
  const upper = percentile(estimates, 0.975);
  return {
    method: 'deterministic paired percentile bootstrap on mean log ratios',
    resamples,
    seed: seed || 1,
    logRatio: {lower, upper},
    ratio: {lower: Math.exp(lower), upper: Math.exp(upper)},
  };
}

function orderEffect(after, before) {
  const candidateAfterBaseline = orderGroup(after);
  const candidateBeforeBaseline = orderGroup(before);
  const countDifference = after.length - before.length;
  if (!after.length || !before.length) {
    return {
      assessable: false,
      candidateAfterBaseline,
      candidateBeforeBaseline,
      relativeOrderCountDifference: countDifference,
      relativeOrderCountsBalanced: Math.abs(countDifference) <= 1,
      reason: 'Both AB and BA relative orders are required.',
    };
  }
  const logDifference =
    mean(after.map(pair => pair.logRatio)) -
    mean(before.map(pair => pair.logRatio));
  return {
    assessable: true,
    candidateAfterBaseline,
    candidateBeforeBaseline,
    relativeOrderCountDifference: countDifference,
    relativeOrderCountsBalanced: Math.abs(countDifference) <= 1,
    logRatioDifferenceAfterMinusBefore: logDifference,
    ratioOfGeometricMeansAfterOverBefore: Math.exp(logDifference),
    effectPercent: (Math.exp(logDifference) - 1) * 100,
  };
}

function orderGroup(pairs) {
  const ratios = pairs.map(pair => pair.ratio);
  return {
    n: pairs.length,
    medianRatio: median(ratios),
    geometricMeanRatio: pairs.length
      ? Math.exp(mean(pairs.map(pair => pair.logRatio)))
      : undefined,
  };
}

function statusReason(status, prerequisites) {
  if (!Object.values(prerequisites).every(Boolean)) {
    const failed = Object.entries(prerequisites)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    return `Prerequisites not met: ${failed.join(', ')}`;
  }
  if (status === 'performance-gain') {
    return 'Median gain is at least 5% and the bootstrap CI is below parity.';
  }
  if (status === 'no-regression') {
    return 'Median slowdown is at most 2% and the bootstrap CI upper bound is below 3% slowdown.';
  }
  if (status === 'regression') {
    return 'Median slowdown exceeds 2% and the bootstrap CI is above parity.';
  }
  return 'The fixed-sample result does not pass a practical gate.';
}

function percentile(values, p) {
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? values[lower]
    : values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '-');
}
