import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(
  await readFile(join(root, 'config/worktrees.json'), 'utf8'),
);

for (const [label, worktree] of Object.entries(config.worktrees)) {
  const worktreeRoot = join(config.benchmarkRoot, worktree.path);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
  }).trim();
  if (!commit.startsWith(config.commit)) {
    throw new Error(`${label} is at ${commit}; expected ${config.commit}`);
  }
  const destination = join(worktreeRoot, 'packages/zero-cache/src');
  await mkdir(destination, {recursive: true});
  await copyFile(
    join(root, 'src/pg-copy-parser.product.bench.ts'),
    join(destination, 'pg-copy-parser.product.bench.ts'),
  );
  await copyFile(
    join(root, 'src/initial-sync-copy-pipeline.product.bench.pg.ts'),
    join(destination, 'initial-sync-copy-pipeline.product.bench.pg.ts'),
  );
  console.log(`${label}: installed benchmark harnesses at ${destination}`);
}

for (const directory of ['raw', 'results', 'manifests']) {
  await mkdir(join(root, directory), {recursive: true});
}
