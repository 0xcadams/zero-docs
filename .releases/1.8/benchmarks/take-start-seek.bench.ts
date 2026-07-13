import {bench, describe} from '../../shared/src/bench.ts';
import {createSilentLogContext} from '../../shared/src/logging-test-utils.ts';
import type {Row} from '../../zero-protocol/src/data.ts';
import {createSchema} from '../../zero-schema/src/builder/schema-builder.ts';
import {
  number,
  string,
  table,
} from '../../zero-schema/src/builder/table-builder.ts';
import {makeSourceChangeEdit} from '../../zql/src/ivm/source.ts';
import {consume} from '../../zql/src/ivm/stream.ts';
import {createBuilder} from '../../zql/src/query/create-builder.ts';
import {Database} from '../../zqlite/src/db.ts';
import {QueryDelegateImpl} from '../../zqlite/src/query-delegate.ts';

const ROW_COUNT = 100_000;
const LIMIT = 50;
const WORKSPACE_ID = 'workspace-1';
const BOUNDARY_DEPTHS = [50, 10_000, 50_000, 90_000, ROW_COUNT] as const;
const requestedDepth = Number(process.env['BENCH_DEPTH']);
const selectedDepths = Number.isFinite(requestedDepth)
  ? BOUNDARY_DEPTHS.filter(depth => depth === requestedDepth)
  : BOUNDARY_DEPTHS;

if (selectedDepths.length === 0) {
  throw new Error(`Unsupported BENCH_DEPTH: ${process.env['BENCH_DEPTH']}`);
}

const activity = table('activity')
  .columns({
    id: string(),
    workspaceID: string(),
    status: string(),
    priority: number(),
    created: number(),
  })
  .primaryKey('id');
const schema = createSchema({tables: [activity]});
const zql = createBuilder(schema);

function key(position: number) {
  return position.toString().padStart(6, '0');
}

function rowAt(position: number, status: 'open' | 'closed'): Row {
  return {
    id: `activity-${key(position)}`,
    workspaceID: WORKSPACE_ID,
    status,
    priority: ROW_COUNT - position,
    created: position,
  };
}

function assertIDs(actual: readonly string[], expected: readonly string[]) {
  if (
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      `Unexpected query result:\nactual: ${actual.join(',')}\nexpected: ${expected.join(',')}`,
    );
  }
}

describe('maintaining orderBy() + limit() query', () => {
  for (const depth of selectedDepths) {
    bench(
      `cutoff ${depth.toLocaleString()} rows deep`,
      function* () {
        const lc = createSilentLogContext();
        const db = new Database(
          lc,
          ':memory:',
          undefined,
          Number.POSITIVE_INFINITY,
        );
        db.exec(/* sql */ `
          CREATE TABLE activity(
            id TEXT NOT NULL,
            workspaceID TEXT NOT NULL,
            status TEXT NOT NULL,
            priority INTEGER NOT NULL,
            created INTEGER NOT NULL
          );
          CREATE UNIQUE INDEX activity_id ON activity(id);
          CREATE INDEX activity_workspace_priority_created
            ON activity(
              workspaceID,
              priority DESC,
              created ASC,
              id ASC,
              status
            );
        `);

        const firstOpenPosition = depth - LIMIT + 1;
        const insert = db.prepare(
          'INSERT INTO activity(id, workspaceID, status, priority, created) VALUES (?, ?, ?, ?, ?)',
        );
        db.transaction(() => {
          for (let position = 1; position <= ROW_COUNT; position++) {
            const row = rowAt(
              position,
              position >= firstOpenPosition && position <= depth
                ? 'open'
                : 'closed',
            );
            insert.run(
              row['id'],
              row['workspaceID'],
              row['status'],
              row['priority'],
              row['created'],
            );
          }
        });

        const delegate = new QueryDelegateImpl(lc, db, schema);
        const query = zql.activity
          .where('workspaceID', WORKSPACE_ID)
          .where('status', 'open')
          .orderBy('priority', 'desc')
          .orderBy('created', 'asc')
          .limit(LIMIT);
        const view = delegate.materialize(query);
        const source = delegate.getSource('activity');

        const boundaryRow = rowAt(depth, 'open');
        const promotedRow = {...boundaryRow, priority: ROW_COUNT + 1};
        const originalIDs = Array.from(
          {length: LIMIT},
          (_, index) =>
            rowAt(firstOpenPosition + index, 'open')['id'] as string,
        );
        const promotedIDs = [
          boundaryRow['id'] as string,
          ...originalIDs.slice(0, -1),
        ];
        const viewIDs = () => view.data.map(row => row.id);

        assertIDs(viewIDs(), originalIDs);
        consume(source.push(makeSourceChangeEdit(promotedRow, boundaryRow)));
        assertIDs(viewIDs(), promotedIDs);
        consume(source.push(makeSourceChangeEdit(boundaryRow, promotedRow)));
        assertIDs(viewIDs(), originalIDs);

        let promoted = false;
        yield () => {
          consume(
            source.push(
              promoted
                ? makeSourceChangeEdit(boundaryRow, promotedRow)
                : makeSourceChangeEdit(promotedRow, boundaryRow),
            ),
          );
          promoted = !promoted;
        };

        if (promoted) {
          consume(source.push(makeSourceChangeEdit(boundaryRow, promotedRow)));
        }
        assertIDs(viewIDs(), originalIDs);
        view.destroy();
        db.close();
      },
      {min_cpu_time: 1, min_samples: 25, max_samples: 25},
    );
  }
});
