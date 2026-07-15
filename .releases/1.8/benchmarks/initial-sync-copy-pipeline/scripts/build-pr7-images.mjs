import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = process.argv.includes('--execute');
const config = JSON.parse(
  await readFile(join(root, 'config/worktrees.json'), 'utf8'),
);
const imageSpecs = [
  {worktree: 'current-pr7-parent', policy: 'adaptive'},
  {worktree: 'current-pr7-head', policy: 'adaptive'},
  {worktree: 'current-pr7-eager', policy: 'eager-secondary'},
];
const manifest = {
  generatedAt: new Date().toISOString(),
  execute,
  platform: 'linux/arm64',
  images: {},
};

for (const spec of imageSpecs) {
  const worktree = config.worktrees[spec.worktree];
  const context = join(config.benchmarkRoot, worktree.path);
  const image = `zero-copy-pipeline-${spec.worktree}:local`;
  const commit = capture('git', ['rev-parse', 'HEAD'], context).trim();
  if (commit !== worktree.commit) {
    throw new Error(
      `${spec.worktree} is at ${commit}; expected ${worktree.commit}`,
    );
  }
  const status = capture('git', ['status', '--short'], context).trim();
  if (spec.worktree === 'current-pr7-parent' && status) {
    throw new Error(`PR 7 parent worktree is dirty:\n${status}`);
  }
  if (status.split('\n').some(line => line.startsWith('??'))) {
    throw new Error(`${spec.worktree} has untracked files:\n${status}`);
  }
  const diff = capture('git', ['diff', '--binary', 'HEAD'], context);
  const buildArgs = [
    'build',
    '--platform',
    'linux/arm64',
    '--build-context',
    `benchmark=${root}`,
    '--file',
    join(root, 'Dockerfile.current-pr7.linux'),
    '--build-arg',
    `PR7_INDEX_POLICY=${spec.policy}`,
    '--tag',
    image,
    context,
  ];
  console.log(`${execute ? 'BUILD' : 'DRY RUN'} ${image}`);
  console.log(`docker ${buildArgs.map(shellQuote).join(' ')}`);
  if (execute) {
    run('docker', buildArgs, root);
  }
  manifest.images[spec.worktree] = {
    image,
    policy: spec.policy,
    context,
    commit,
    status,
    diffSHA256: createHash('sha256').update(diff).digest('hex'),
    imageID: execute
      ? capture(
          'docker',
          ['image', 'inspect', '--format', '{{.Id}}', image],
          root,
        ).trim()
      : null,
  };
}

await writeFile(
  join(root, 'manifests/pr7-images.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8'});
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
