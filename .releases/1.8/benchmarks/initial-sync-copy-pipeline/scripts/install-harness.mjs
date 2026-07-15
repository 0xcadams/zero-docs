import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assertCanonicalSource,
  inspectGitSource,
  sha256File,
} from './provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(join(root, 'config/worktrees.json'), 'utf8'),
);
const noncanonical = process.argv.includes('--noncanonical');
const requestedLabels = new Set(
  process.argv.slice(2).filter(argument => !argument.startsWith('--')),
);
if (noncanonical && requestedLabels.size === 0) {
  throw new Error(
    'Noncanonical installation requires explicit experiment worktree labels',
  );
}
for (const label of requestedLabels) {
  if (!config.worktrees[label]) {
    throw new Error(`Unknown worktree ${label}`);
  }
}

const harnesses = [
  'src/pg-copy-parser.product.bench.ts',
  'src/initial-sync-copy-pipeline.product.bench.pg.ts',
];
const harnessHashes = Object.fromEntries(
  await Promise.all(
    harnesses.map(async path => [path, await sha256File(join(root, path))]),
  ),
);

for (const [label, worktree] of Object.entries(config.worktrees)) {
  if (
    requestedLabels.size > 0
      ? !requestedLabels.has(label)
      : worktree.defaultInstall === false
  ) {
    continue;
  }
  const worktreeRoot = join(config.benchmarkRoot, worktree.path);
  const source = await inspectGitSource(worktreeRoot);
  if (!noncanonical) {
    assertCanonicalSource(
      label,
      source,
      worktree.commit ?? config.commit,
      worktree.tree ?? config.tree,
    );
    console.log(`${label}: canonical source identity validated`);
    continue;
  }
  const destination = join(worktreeRoot, 'packages/zero-cache/src');
  await mkdir(destination, {recursive: true});
  for (const path of harnesses) {
    await copyFile(join(root, path), join(destination, path.slice(4)));
  }
  console.log(
    `${label}: installed noncanonical harnesses ${JSON.stringify({source, harnessHashes})}`,
  );
}

if (!noncanonical) {
  throw new Error(
    'Canonical harnesses are injected by experiment Dockerfiles without mutating product source; pass --noncanonical with explicit worktree labels to install development harnesses',
  );
}
