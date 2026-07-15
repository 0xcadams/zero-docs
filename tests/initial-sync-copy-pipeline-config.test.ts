import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {
  expandExperimentProfiles,
  parameterBoundaryColumnCounts,
  paretoRowCounts,
  publicationOrder,
  validateExperimentConfig,
  validateIntegrationProfiles,
} from '../.releases/1.8/benchmarks/initial-sync-copy-pipeline/config/src/experiment-config';

const root = new URL(
  '../.releases/1.8/benchmarks/initial-sync-copy-pipeline/',
  import.meta.url,
);

function readJSON(relativePath: string) {
  return JSON.parse(
    readFileSync(new URL(relativePath, root), 'utf8'),
  ) as unknown;
}

describe('initial sync COPY pipeline fixture configuration', () => {
  test('legacy profiles are exact-byte calibration profiles', () => {
    const profiles = validateIntegrationProfiles(
      readJSON('config/integration-profiles.json'),
    );
    expect(Object.keys(profiles)).toHaveLength(8);
    for (const profileValue of Object.values(profiles)) {
      const profile = profileValue as Record<string, unknown>;
      expect(profile.canonical).toBe(false);
      expect(profile.validationMode).toBe('calibration');
      expect(profile.workerCount).toBe(5);
      expect(profile.fixtureVersion).toMatch(/-v1$/);
      expect(profile.fixtureSeed).toBe(20250714);
      expect(profile.cachePolicy).toBeTypeOf('object');
      expect(profile.sourceStrategy).toBeTypeOf('object');
      expect(profile.docker).toEqual({
        cpus: 1,
        memory: '3g',
        nodeHeapMB: 2304,
      });
      const expected = profile.expected as Record<string, unknown>;
      expect(expected.rowCount).toBe(profile.rows);
      expect(expected.copyBytes).toBe(profile.expectedCopyBytes);
      expect(expected.copyDigest).toBeNull();
      expect(expected.contentDigest).toBeNull();
    }
  });

  test('canonical profiles fail closed without all exact expectations', () => {
    const profiles = readJSON('config/integration-profiles.json') as Record<
      string,
      Record<string, unknown>
    >;
    const profile = structuredClone(profiles['email-smoke-100m']);
    profile.canonical = true;
    profile.validationMode = 'canonical';
    expect(() => validateIntegrationProfiles({canonical: profile})).toThrow(
      'canonical expectations must all be exact',
    );

    profile.expected = {
      ...(profile.expected as object),
      copyDigest: `sha256:${'1'.repeat(64)}`,
      contentDigest: `sha256:${'2'.repeat(64)}`,
    };
    expect(() =>
      validateIntegrationProfiles({canonical: profile}),
    ).not.toThrow();
  });

  test('future families expand to explicit noncanonical profiles', () => {
    const config = readJSON('config/experiment-families.json') as {
      families: Record<string, {axes: Record<string, unknown[]>}>;
    };
    validateExperimentConfig(config);
    const profiles = expandExperimentProfiles(config);
    expect(profiles.length).toBeGreaterThan(300);
    expect(new Set(profiles.map(profile => profile.id)).size).toBe(
      profiles.length,
    );
    expect(new Set(profiles.map(profile => profile.family))).toEqual(
      new Set([
        'many-table-publications',
        'schema-heavy',
        'parameter-boundaries',
        'parameter-tail-boundaries',
        'estimator',
        'index-topology-cache',
        'concurrent-buffering',
        'native-ingestor-protocol',
      ]),
    );
    for (const profile of profiles) {
      expect(profile.canonical).toBe(false);
      expect(profile.validationMode).toBe('calibration');
      expect(profile.expected.rowCount).toBeGreaterThanOrEqual(0);
      expect(profile.expected.copyBytes).toBeNull();
      expect(profile.expected.copyDigest).toBeNull();
      expect(profile.expected.contentDigest).toBeNull();
      expect(profile.workerCount).toBeGreaterThan(0);
      expect(profile.cachePolicy).toBeTypeOf('object');
      expect(profile.sourceStrategy).toBeTypeOf('object');
      expect(profile.docker).toEqual({
        cpus: 1,
        memory: '3g',
        nodeHeapMB: 2304,
      });
    }

    expect(config.families['many-table-publications'].axes.tableCount).toEqual([
      32, 108, 500,
    ]);
    expect(
      config.families['many-table-publications'].axes.publicationOrder,
    ).toEqual(['large-first', 'large-last', 'seeded-random']);
    expect(config.families['schema-heavy'].axes.topology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({tableCount: 108, indexCount: 345}),
        expect.objectContaining({tableCount: 500, indexCount: 1500}),
      ]),
    );
    expect(config.families['parameter-boundaries'].axes.rowCount).toEqual([
      0, 1, 49, 50, 51, 99, 100, 101,
    ]);
    expect(config.families['parameter-tail-boundaries'].axes.tailRows).toEqual([
      0, 1, 49, 50, 51, 99, 100, 101,
    ]);
    const estimatorCases = (
      config.families.estimator.axes.case as {name: string}[]
    ).map(fixtureCase => fixtureCase.name);
    expect(estimatorCases).toEqual(
      expect.arrayContaining([
        'toast-compressed',
        'toast-incompressible',
        'stale-statistics-grow',
        'unanalyzed',
        'bloat',
        'empty',
        'filtered-publication',
        'column-subset',
        'arrays-custom-types',
        'threshold-minus-one',
        'threshold-exact',
        'threshold-plus-one',
      ]),
    );
    expect(
      config.families['index-topology-cache'].axes.indexTopology,
    ).toHaveLength(5);
    expect(config.families['concurrent-buffering'].axes.case).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: 'many-active-tables'}),
        expect.objectContaining({name: 'oversized-row'}),
      ]),
    );
    expect(config.families['native-ingestor-protocol'].axes.case).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: 'mixed-native-types'}),
        expect.objectContaining({name: 'fragmented-large-fields'}),
      ]),
    );
  });

  test('Pareto sizes and publication orders are deterministic', () => {
    const sizes = paretoRowCounts(108, 1_000_000, 1.16, 1, 20250715);
    expect(sizes).toHaveLength(108);
    expect(sizes.reduce((sum, rows) => sum + rows, 0)).toBe(1_000_000);
    expect(paretoRowCounts(108, 1_000_000, 1.16, 1, 20250715)).toEqual(sizes);

    const first = publicationOrder(sizes, 'large-first', 20250715);
    const last = publicationOrder(sizes, 'large-last', 20250715);
    const random = publicationOrder(sizes, 'seeded-random', 20250715);
    expect(last).toEqual([...first].reverse());
    expect(random).toEqual(publicationOrder(sizes, 'seeded-random', 20250715));
    expect([...random].sort((left, right) => left - right)).toEqual(
      Array.from({length: 108}, (_, index) => index),
    );
  });

  test('column generation straddles SQLite parameter boundaries', () => {
    const columns = parameterBoundaryColumnCounts(
      32766,
      [1, 49, 50, 51, 99, 100, 101],
      [-1, 0, 1],
      1600,
    );
    expect(columns).toEqual(
      expect.arrayContaining([1, 323, 324, 325, 326, 327, 328, 329, 330, 331]),
    );
    expect(columns).toEqual(
      expect.arrayContaining([654, 655, 656, 667, 668, 669]),
    );
    expect(Math.max(...columns)).toBeLessThanOrEqual(1600);
  });

  test('definition-only stages reference active worktrees and profiles', () => {
    const stages = readJSON('config/integration-stages.json') as Record<
      string,
      Record<string, unknown>
    >;
    const config = readJSON('config/experiment-families.json') as {
      families: Record<string, unknown>;
    };
    const profiles = readJSON('config/integration-profiles.json') as Record<
      string,
      unknown
    >;
    const worktreeConfig = readJSON('config/worktrees.json') as {
      worktrees: Record<string, unknown>;
      addonWorktrees: Record<string, unknown>;
    };
    const futureStages = Object.values(stages).filter(
      stage => stage.status === 'definition-only-do-not-execute',
    );
    expect(futureStages).toHaveLength(13);
    for (const stage of futureStages) {
      expect(stage.repetitions).toBeGreaterThan(0);
      expect(stage.treatments).toBeInstanceOf(Array);
      expect((stage.treatments as unknown[]).length).toBeGreaterThan(0);
      for (const profile of (stage.profiles ?? []) as string[]) {
        expect(profiles).toHaveProperty(profile);
      }
      for (const family of (stage.profileFamilies ?? []) as string[]) {
        expect(config.families).toHaveProperty(family);
      }
      for (const treatment of stage.treatments as Record<string, unknown>[]) {
        expect(worktreeConfig.worktrees).toHaveProperty(
          treatment.worktree as string,
        );
        if (treatment.addonWorktree !== undefined) {
          expect(worktreeConfig.addonWorktrees).toHaveProperty(
            treatment.addonWorktree as string,
          );
        }
      }
    }
  });
});
