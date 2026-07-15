type JsonRecord = Record<string, unknown>;

export type ExactExpectations = {
  rowCount: number | null;
  copyBytes: number | null;
  copyDigest: string | null;
  contentDigest: string | null;
};

export type ExpandedExperimentProfile = {
  id: string;
  family: string;
  generator: string;
  canonical: boolean;
  validationMode: string;
  fixtureVersion: string;
  fixtureSeed: number;
  workerCount: number;
  docker: {cpus: 1; memory: '3g'; nodeHeapMB: 2304};
  cachePolicy: JsonRecord;
  sourceStrategy: JsonRecord;
  expected: ExactExpectations;
  fixture: JsonRecord;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function validateIntegrationProfiles(value: unknown) {
  const profiles = record(value, 'integration profiles');
  for (const [name, candidate] of Object.entries(profiles)) {
    const profile = record(candidate, `profile ${name}`);
    validateProfileContract(profile, name);
    integer(profile.rows, `${name}.rows`, 0);
    integer(profile.payloadBytes, `${name}.payloadBytes`, 1);
    integer(profile.copyChunkBytes, `${name}.copyChunkBytes`, 1);
    integer(profile.expectedCopyBytes, `${name}.expectedCopyBytes`, 0);
    const expected = record(profile.expected, `${name}.expected`);
    if (expected.rowCount !== profile.rows) {
      throw new Error(`${name}.expected.rowCount must exactly equal rows`);
    }
    if (expected.copyBytes !== profile.expectedCopyBytes) {
      throw new Error(
        `${name}.expected.copyBytes must exactly equal expectedCopyBytes`,
      );
    }
  }
  return profiles;
}

export function validateExperimentConfig(value: unknown) {
  const config = record(value, 'experiment config');
  if (config.schemaVersion !== 1) {
    throw new Error('experiment config schemaVersion must be 1');
  }
  if (config.status !== 'definition-only-do-not-execute') {
    throw new Error('experiment config must remain definition-only');
  }
  const defaults = record(config.defaults, 'experiment defaults');
  validateProfileContract(defaults, 'experiment defaults', true);
  const generators = record(config.generators, 'experiment generators');
  const families = record(config.families, 'experiment families');
  for (const [name, candidate] of Object.entries(families)) {
    const family = record(candidate, `family ${name}`);
    const generator = string(family.generator, `${name}.generator`);
    if (!(generator in generators)) {
      throw new Error(`${name} references unknown generator ${generator}`);
    }
    const axes = record(family.axes, `${name}.axes`);
    if (Object.keys(axes).length === 0) {
      throw new Error(`${name} must define at least one axis`);
    }
    for (const [axisName, axis] of Object.entries(axes)) {
      if (!Array.isArray(axis) || axis.length === 0) {
        throw new Error(`${name}.axes.${axisName} must be a non-empty array`);
      }
    }
  }
  for (const profile of expandExperimentProfiles(config)) {
    validateProfileContract(profile as unknown as JsonRecord, profile.id);
  }
  return config;
}

export function expandExperimentProfiles(
  value: unknown,
): ExpandedExperimentProfile[] {
  const config = record(value, 'experiment config');
  const defaults = record(config.defaults, 'experiment defaults');
  const families = record(config.families, 'experiment families');
  const profiles: ExpandedExperimentProfile[] = [];

  for (const [familyName, candidate] of Object.entries(families)) {
    const family = record(candidate, `family ${familyName}`);
    const axes = record(family.axes, `${familyName}.axes`);
    for (const selected of cartesianAxes(axes)) {
      const expectedRowCount = resolveExpectedRowCount(family, selected);
      const expectedDefaults = record(
        defaults.expected,
        'experiment defaults.expected',
      );
      const workerCount =
        selected.workerCount === undefined
          ? integer(defaults.workerCount, 'defaults.workerCount', 1)
          : integer(selected.workerCount, `${familyName}.workerCount`, 1);
      const selectedCache = selected.cachePolicy;
      const cachePolicy =
        selectedCache === undefined
          ? record(defaults.cachePolicy, 'defaults.cachePolicy')
          : record(selectedCache, `${familyName}.cachePolicy`);
      profiles.push({
        id: profileID(familyName, selected),
        family: familyName,
        generator: string(family.generator, `${familyName}.generator`),
        canonical: defaults.canonical === true,
        validationMode: string(
          defaults.validationMode,
          'defaults.validationMode',
        ),
        fixtureVersion: string(
          defaults.fixtureVersion,
          'defaults.fixtureVersion',
        ),
        fixtureSeed: integer(defaults.fixtureSeed, 'defaults.fixtureSeed', 0),
        workerCount,
        docker: applicationConstraints(defaults.docker, 'defaults.docker'),
        cachePolicy,
        sourceStrategy: record(
          defaults.sourceStrategy,
          'defaults.sourceStrategy',
        ),
        expected: {
          rowCount: expectedRowCount,
          copyBytes: nullableInteger(expectedDefaults.copyBytes, 'copyBytes'),
          copyDigest: nullableString(expectedDefaults.copyDigest, 'copyDigest'),
          contentDigest: nullableString(
            expectedDefaults.contentDigest,
            'contentDigest',
          ),
        },
        fixture: {
          generator: family.generator,
          ...record(family.fixture ?? {}, `${familyName}.fixture`),
          ...selected,
        },
      });
    }
  }
  return profiles;
}

export function paretoRowCounts(
  tableCount: number,
  totalRows: number,
  alpha: number,
  minimumRows: number,
  seed: number,
) {
  integer(tableCount, 'tableCount', 1);
  integer(totalRows, 'totalRows', 0);
  integer(minimumRows, 'minimumRows', 0);
  if (!Number.isFinite(alpha) || alpha <= 0) {
    throw new Error('alpha must be positive');
  }
  if (minimumRows * tableCount > totalRows) {
    throw new Error('minimumRows cannot exceed totalRows');
  }
  const distributable = totalRows - minimumRows * tableCount;
  const weights = Array.from(
    {length: tableCount},
    (_, rank) => (rank + 1) ** -alpha,
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const rows = weights.map(
    weight => minimumRows + Math.floor((distributable * weight) / weightTotal),
  );
  let remainder = totalRows - rows.reduce((sum, count) => sum + count, 0);
  for (const index of seededOrder(tableCount, seed)) {
    if (remainder-- === 0) {
      break;
    }
    rows[index]++;
  }
  return rows;
}

export function publicationOrder(
  sizes: readonly number[],
  order: 'large-first' | 'large-last' | 'seeded-random',
  seed: number,
) {
  if (order === 'seeded-random') {
    return seededOrder(sizes.length, seed);
  }
  const result = sizes
    .map((size, index) => ({index, size}))
    .sort((left, right) => right.size - left.size || left.index - right.index)
    .map(({index}) => index);
  return order === 'large-first' ? result : result.reverse();
}

export function parameterBoundaryColumnCounts(
  sqliteVariableLimit: number,
  rowsPerStatement: readonly number[],
  deltas: readonly number[],
  postgresColumnLimit: number,
) {
  integer(sqliteVariableLimit, 'sqliteVariableLimit', 1);
  integer(postgresColumnLimit, 'postgresColumnLimit', 1);
  const counts = new Set([1]);
  for (const rows of rowsPerStatement) {
    integer(rows, 'rowsPerStatement', 1);
    for (const delta of deltas) {
      integer(delta, 'column delta', Number.MIN_SAFE_INTEGER);
      const count = Math.floor(sqliteVariableLimit / rows) + delta;
      if (count >= 1 && count <= postgresColumnLimit) {
        counts.add(count);
      }
    }
  }
  return [...counts].sort((left, right) => left - right);
}

function validateProfileContract(
  profile: JsonRecord,
  name: string,
  allowNullExpectedRows = false,
) {
  if (typeof profile.canonical !== 'boolean') {
    throw new Error(`${name}.canonical must be boolean`);
  }
  const validationMode = string(
    profile.validationMode,
    `${name}.validationMode`,
  );
  if (!['canonical', 'calibration', 'exploratory'].includes(validationMode)) {
    throw new Error(`${name}.validationMode is invalid`);
  }
  if (profile.canonical !== (validationMode === 'canonical')) {
    throw new Error(`${name}.canonical must agree with validationMode`);
  }
  string(profile.fixtureVersion, `${name}.fixtureVersion`);
  integer(profile.fixtureSeed, `${name}.fixtureSeed`, 0);
  integer(profile.workerCount, `${name}.workerCount`, 1);
  applicationConstraints(profile.docker, `${name}.docker`);
  const cachePolicy = record(profile.cachePolicy, `${name}.cachePolicy`);
  string(cachePolicy.betweenRuns, `${name}.cachePolicy.betweenRuns`);
  const sourceStrategy = record(
    profile.sourceStrategy,
    `${name}.sourceStrategy`,
  );
  string(sourceStrategy.clone, `${name}.sourceStrategy.clone`);
  string(sourceStrategy.reset, `${name}.sourceStrategy.reset`);
  const expected = record(profile.expected, `${name}.expected`);
  const rowCount = nullableInteger(
    expected.rowCount,
    `${name}.expected.rowCount`,
  );
  const copyBytes = nullableInteger(
    expected.copyBytes,
    `${name}.expected.copyBytes`,
  );
  const copyDigest = nullableString(
    expected.copyDigest,
    `${name}.expected.copyDigest`,
  );
  const contentDigest = nullableString(
    expected.contentDigest,
    `${name}.expected.contentDigest`,
  );
  if (copyDigest !== null && !SHA256.test(copyDigest)) {
    throw new Error(`${name}.expected.copyDigest is not a sha256 digest`);
  }
  if (contentDigest !== null && !SHA256.test(contentDigest)) {
    throw new Error(`${name}.expected.contentDigest is not a sha256 digest`);
  }
  if (
    profile.canonical &&
    (rowCount === null ||
      copyBytes === null ||
      copyDigest === null ||
      contentDigest === null)
  ) {
    throw new Error(`${name} canonical expectations must all be exact`);
  }
  if (!allowNullExpectedRows && rowCount === null) {
    throw new Error(`${name}.expected.rowCount must be exact`);
  }
}

function applicationConstraints(value: unknown, name: string) {
  const constraints = record(value, name);
  if (
    constraints.cpus !== 1 ||
    constraints.memory !== '3g' ||
    constraints.nodeHeapMB !== 2304
  ) {
    throw new Error(`${name} must use 1 CPU, 3g memory, and 2304 MB heap`);
  }
  return constraints as {cpus: 1; memory: '3g'; nodeHeapMB: 2304};
}

function resolveExpectedRowCount(family: JsonRecord, selected: JsonRecord) {
  const topology = optionalRecord(selected.topology, 'selected topology');
  const fixtureCase = optionalRecord(selected.case, 'selected case');
  const fixture = optionalRecord(family.fixture, 'family fixture');
  const tailRowCount =
    selected.tailRows === undefined
      ? undefined
      : integer(selected.rowsPerStatement, 'rowsPerStatement', 1) *
          integer(fixture?.fullBatchCount, 'fullBatchCount', 0) +
        integer(selected.tailRows, 'tailRows', 0);
  const candidate =
    selected.rowCount ??
    tailRowCount ??
    topology?.expectedRowCount ??
    fixtureCase?.expectedRowCount ??
    fixtureCase?.rows ??
    family.expectedRowCount;
  return integer(candidate, 'generated expected row count', 0);
}

function cartesianAxes(axes: JsonRecord): JsonRecord[] {
  let combinations: JsonRecord[] = [{}];
  for (const [name, values] of Object.entries(axes)) {
    if (!Array.isArray(values)) {
      throw new Error(`axis ${name} must be an array`);
    }
    combinations = combinations.flatMap(combination =>
      values.map(value => ({...combination, [name]: value})),
    );
  }
  return combinations;
}

function profileID(family: string, selected: JsonRecord) {
  const suffix = Object.values(selected).map(profileIDPart).join('-');
  return `${family}-${suffix}`;
}

function profileIDPart(value: unknown): string {
  if (isRecord(value)) {
    if (typeof value.name === 'string') {
      return profileIDPart(value.name);
    }
    return Object.entries(value)
      .map(([key, nested]) => `${profileIDPart(key)}-${profileIDPart(nested)}`)
      .join('-');
  }
  if (Array.isArray(value)) {
    return value.map(profileIDPart).join('-');
  }
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-');
}

function seededOrder(length: number, initialSeed: number) {
  const values = Array.from({length}, (_, index) => index);
  let seed = initialSeed >>> 0 || 0x9e3779b9;
  for (let index = values.length - 1; index > 0; index--) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const other = (seed >>> 0) % (index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function record(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function optionalRecord(value: unknown, name: string) {
  return value === undefined ? undefined : record(value, name);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string) {
  return value === null ? null : string(value, name);
}

function integer(value: unknown, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function nullableInteger(value: unknown, name: string) {
  return value === null ? null : integer(value, name, 0);
}
