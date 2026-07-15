import {writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  conditionDescriptor,
  primaryRunMetric,
  reconcileArtifacts,
  stableStringify,
} from './analysis.mjs';
import {loadArtifactSet, parseRunArtifacts} from './artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = process.argv[2];
const selection = process.argv[3];
const forceLegacy = selection === '--legacy';
const runToken = forceLegacy ? undefined : selection;
if (!stage) {
  throw new Error(
    'Usage: node scripts/aggregate.mjs <stage> [run-token|--legacy]',
  );
}
const artifactSet = await loadArtifactSet({
  root,
  stage,
  runToken,
  forceLegacy,
});
const {manifest} = artifactSet;
const runs = parseRunArtifacts(artifactSet.files);

const reconciliation = reconcileArtifacts(manifest, runs, {
  canonicalArtifact: artifactSet.canonical,
});
const conditionVariantsByProfile = new Map();
for (const condition of reconciliation.conditions) {
  const variants =
    conditionVariantsByProfile.get(condition.condition.profile) ?? new Set();
  variants.add(condition.key);
  conditionVariantsByProfile.set(condition.condition.profile, variants);
}

const groups = new Map();
const independentRuns = [];
for (const run of runs) {
  const condition = conditionDescriptor(
    {
      ...run.meta.runConfig,
      ...(run.meta.constraints === undefined
        ? {}
        : {constraints: run.meta.constraints}),
    },
    manifest,
  );
  const supplementalCondition = Object.fromEntries(
    Object.entries(condition).filter(([key]) => key !== 'profile'),
  );
  const conditionLabel =
    conditionVariantsByProfile.get(condition.profile).size > 1
      ? `${condition.profile}|${stableStringify(supplementalCondition)}`
      : condition.profile;
  const key = `${conditionLabel}/${run.meta.runConfig.label ?? run.meta.runConfig.worktree}`;
  const runValue = primaryRunMetric(run.result);
  if (!Number.isFinite(runValue)) {
    throw new Error(`Missing primary run metric in ${run.file}`);
  }
  const entry = groups.get(key) ?? [];
  entry.push(runValue);
  groups.set(key, entry);
  independentRuns.push({
    id: run.meta.id,
    file: run.file,
    condition,
    treatment: run.meta.runConfig.label ?? run.meta.runConfig.worktree,
    repetition: run.meta.runConfig.repetition,
    value: runValue,
  });
}
const summary = Object.fromEntries(
  [...groups].map(([key, values]) => [key, summarize(values)]),
);
const resultKinds = [...new Set(runs.map(run => run.result.kind))];
if (resultKinds.length !== 1) {
  throw new Error(`Stage mixes result kinds: ${resultKinds.join(', ')}`);
}
const primaryMetric =
  resultKinds[0] === 'initial-sync'
    ? {
        name: 'outerMs',
        description: 'Whole awaited initReplica wall time through readiness',
        experimentalUnit: 'independent process run within a complete block',
      }
    : {
        name: 'processMedianWallMs',
        description:
          'Median in-process wall time, reduced to one value per independent process run',
        experimentalUnit: 'independent process run within a complete block',
      };
const output = {
  schemaVersion: 2,
  stage,
  generatedAt: new Date().toISOString(),
  primaryMetric,
  artifactSource: artifactSet.source,
  artifactReconciliation: reconciliation,
  analysis: {
    classification: reconciliation.classification,
    classificationReason: reconciliation.classificationReason,
    plannedSampleCount: reconciliation.plannedSampleCount,
    observedSampleCount: reconciliation.actualRunCount,
    fixedSamplePolicy:
      'Confirmatory gates require a predeclared analysis plan and its complete fixed sample.',
    runs: independentRuns,
  },
  compatibility: {
    summary:
      'Noncanonical exploratory view retained for backward readers; n counts independent process runs, not in-process samples.',
  },
  runs,
  summary,
};
await writeFile(
  join(root, 'results', `${stage}.json`),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function summarize(input) {
  const values = [...input].sort((a, b) => a - b);
  return {
    n: values.length,
    minMs: values[0],
    medianMs: percentile(values, 0.5),
    maxMs: values.at(-1),
    p95Suppressed: true,
    p95SuppressionReason:
      'Fixed-N benchmark groups are too small for a useful tail-percentile claim.',
  };
}

function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return values[lower];
  }
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}
