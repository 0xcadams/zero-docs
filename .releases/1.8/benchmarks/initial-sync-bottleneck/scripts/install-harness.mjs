import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const config = JSON.parse(
  await readFile(join(root, 'config/worktrees.json'), 'utf8'),
);
const harnessSource = join(
  root,
  'src/initial-sync-bottleneck.product.bench.pg.ts',
);

for (const [label, worktree] of Object.entries(config.worktrees)) {
  const worktreeRoot = join(config.benchmarkRoot, worktree.path);
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreeRoot,
    encoding: 'utf8',
  }).trim();
  if (actualCommit !== worktree.commit) {
    throw new Error(
      `${label} is at ${actualCommit}; expected immutable benchmark commit ${worktree.commit}`,
    );
  }
  const destination = join(worktreeRoot, 'packages/zero-cache/src');
  await mkdir(destination, {recursive: true});
  await copyFile(
    harnessSource,
    join(destination, 'initial-sync-bottleneck.product.bench.pg.ts'),
  );
  await copyFile(
    join(root, 'src', worktree.adapter),
    join(destination, 'initial-sync-bottleneck-adapter.ts'),
  );
  console.log(`${label}: installed benchmark-only harness at ${destination}`);
}

for (const directory of ['raw', 'profiles', 'results', 'manifests']) {
  await mkdir(join(root, directory), {recursive: true});
}
