import {afterAll} from 'vitest';
import {testLogConfig} from '../../otel/src/test-log-config.ts';
import {bench, describe, use} from '../../shared/src/bench.ts';
import {createSilentLogContext} from '../../shared/src/logging-test-utils.ts';
import type {SchemaValue} from '../../zero-schema/src/table-schema.ts';
import {Database} from '../../zqlite/src/db.ts';
import {TableSource} from '../../zqlite/src/table-source.ts';

const ROW_COUNT = 100_000;
const WORKSPACE_ID = 'workspace-1';
const BOUNDARIES = [
  ['after 50 rows', 49],
  ['after 10,000 rows', 9_999],
  ['after 50,000 rows', 49_999],
  ['after 90,000 rows', 89_999],
  ['after final row', ROW_COUNT - 1],
] as const;

const columns = {
  workspaceID: {type: 'string'},
  id: {type: 'string'},
  priority: {type: 'number'},
  created: {type: 'number'},
} as const satisfies Record<string, SchemaValue>;

function key(index: number) {
  return index.toString().padStart(6, '0');
}

const db = new Database(
  createSilentLogContext(),
  ':memory:',
  undefined,
  Number.POSITIVE_INFINITY,
);
db.exec(/* sql */ `
  CREATE TABLE issues(
    workspaceID TEXT NOT NULL,
    id TEXT NOT NULL,
    priority INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX issues_id ON issues(id);
  CREATE INDEX issues_workspace_priority_created
    ON issues(workspaceID, priority DESC, created ASC, id ASC);
`);

const insert = db.prepare(
  'INSERT INTO issues(workspaceID, id, priority, created) VALUES (?, ?, ?, ?)',
);
db.transaction(() => {
  for (let i = 0; i < ROW_COUNT; i++) {
    insert.run(WORKSPACE_ID, `issue-${key(i)}`, ROW_COUNT - i, i);
  }
});

const source = new TableSource(
  createSilentLogContext(),
  testLogConfig,
  db,
  'issues',
  columns,
  ['id'],
);
const input = source.connect([
  ['priority', 'desc'],
  ['created', 'asc'],
  ['id', 'asc'],
]);

function fetchAfter(index: number) {
  let count = 0;
  for (const node of input.fetch({
    constraint: {workspaceID: WORKSPACE_ID},
    start: {
      row: {
        workspaceID: WORKSPACE_ID,
        id: `issue-${key(index)}`,
        priority: ROW_COUNT - index,
        created: index,
      },
      basis: 'after',
    },
  })) {
    if (node === 'yield') {
      continue;
    }
    use(node);
    if (++count === 2) {
      break;
    }
  }
  use(count);
}

for (const [, index] of BOUNDARIES) {
  fetchAfter(index);
}

afterAll(() => {
  db.close();
});

describe('ordered limit boundary fetch', () => {
  for (const [name, index] of BOUNDARIES) {
    bench(name, () => fetchAfter(index));
  }
});
