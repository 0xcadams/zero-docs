import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  assertCanonicalSource,
  inspectDockerImage,
  inspectGitSource,
  requireDigestReference,
  sha256File,
} from './provenance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = process.argv.includes('--execute');
const noncanonical = process.argv.includes('--noncanonical');
const canonical = !noncanonical;
const nodeImageArgument = process.argv.find(argument =>
  argument.startsWith('--node-image='),
);
const [config, runnerConfig] = await Promise.all([
  readJSON('config/worktrees.json'),
  readJSON('config/runner.json'),
]);
const nodeImage =
  nodeImageArgument?.slice('--node-image='.length) ??
  runnerConfig.baseImages.node;
if (canonical) {
  requireDigestReference('Node base image', nodeImage);
}
if (!nodeImage) {
  throw new Error('A Node base image is required');
}

const imageSpecs = [
  {worktree: 'origin-main', policy: 'adaptive'},
  {worktree: 'adaptive-index', policy: 'adaptive'},
  {worktree: 'adaptive-index-eager', policy: 'eager-secondary'},
];
const inputPaths = {
  harness: 'src/initial-sync-copy-pipeline.product.bench.pg.ts',
  policyTransform: 'scripts/force-eager-secondary-indexes.mjs',
  dockerfile: 'Dockerfile.adaptive-index.linux',
  builder: 'scripts/build-adaptive-index-images.mjs',
  provenance: 'scripts/provenance.mjs',
  worktrees: 'config/worktrees.json',
  runnerConfig: 'config/runner.json',
};
const inputHashes = Object.fromEntries(
  await Promise.all(
    Object.entries(inputPaths).map(async ([name, path]) => [
      name,
      {path, sha256: await sha256File(join(root, path))},
    ]),
  ),
);
const prepared = [];
for (const spec of imageSpecs) {
  const worktree = config.worktrees[spec.worktree];
  const context = join(config.benchmarkRoot, worktree.path);
  const source = await inspectGitSource(context);
  if (canonical) {
    assertCanonicalSource(
      spec.worktree,
      source,
      worktree.commit ?? config.commit,
      worktree.tree ?? config.tree,
    );
  }
  prepared.push({...spec, context, source});
}

const generatedAt = new Date().toISOString();
const runToken = `${generatedAt.replaceAll(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`;
const manifest = {
  schemaVersion: 2,
  runToken,
  generatedAt,
  execute,
  mode: canonical ? 'canonical' : 'noncanonical',
  status: execute ? 'preparing' : 'dry-run',
  platform: runnerConfig.platform,
  nodeBaseImageReference: nodeImage,
  nodeBaseImage: null,
  inputHashes,
  images: {},
};

let manifestPath;
if (execute) {
  const outputDirectory = join(
    root,
    'manifests',
    'build-adaptive-index-images',
    runToken,
  );
  await mkdir(dirname(outputDirectory), {recursive: true});
  await mkdir(outputDirectory);
  manifestPath = join(outputDirectory, 'manifest.json');
  await writeManifest();
}

try {
  if (execute) {
    run('docker', ['pull', '--platform', runnerConfig.platform, nodeImage]);
    manifest.nodeBaseImage = inspectDockerImage(nodeImage, root);
  }
  for (const spec of prepared) {
    const image = `zero-copy-pipeline-${spec.worktree}:local`;
    const labels = {
      'dev.rocicorp.zero-benchmark.worktree': spec.worktree,
      'dev.rocicorp.zero-benchmark.source-commit': spec.source.commit,
      'dev.rocicorp.zero-benchmark.source-tree': spec.source.tree,
      'dev.rocicorp.zero-benchmark.source-diff-sha256': spec.source.diffSHA256,
      'dev.rocicorp.zero-benchmark.harness-sha256': inputHashes.harness.sha256,
      'dev.rocicorp.zero-benchmark.config-sha256': inputHashes.worktrees.sha256,
      'dev.rocicorp.zero-benchmark.builder-sha256': inputHashes.builder.sha256,
      'dev.rocicorp.zero-benchmark.node-image': nodeImage,
      'dev.rocicorp.zero-benchmark.adaptive-index-policy': spec.policy,
    };
    const buildArgs = [
      'build',
      '--platform',
      runnerConfig.platform,
      '--build-context',
      `benchmark=${root}`,
      '--file',
      join(root, 'Dockerfile.adaptive-index.linux'),
      '--build-arg',
      `NODE_IMAGE=${nodeImage}`,
      '--build-arg',
      `ADAPTIVE_INDEX_POLICY=${spec.policy}`,
      ...Object.entries(labels).flatMap(([name, value]) => [
        '--label',
        `${name}=${value}`,
      ]),
      '--tag',
      image,
      spec.context,
    ];
    console.log(`${execute ? 'BUILD' : 'DRY RUN'} ${image}`);
    console.log(`docker ${buildArgs.map(shellQuote).join(' ')}`);
    let imageProvenance = null;
    if (execute) {
      run('docker', buildArgs);
      imageProvenance = inspectDockerImage(image, root);
      if (canonical) {
        assertLabels(spec.worktree, imageProvenance.labels, labels);
      }
    }
    manifest.images[spec.worktree] = {
      image,
      policy: spec.policy,
      source: spec.source,
      expectedLabels: labels,
      provenance: imageProvenance,
    };
    if (execute) {
      await writeManifest();
    }
  }
  if (execute) {
    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    await writeManifest();
  }
} catch (error) {
  if (execute) {
    manifest.status = 'failed';
    manifest.failedAt = new Date().toISOString();
    manifest.failure = error instanceof Error ? error.message : String(error);
    await writeManifest();
  }
  throw error;
}

function assertLabels(label, actual, expected) {
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) {
      throw new Error(
        `${label} image provenance ${name} is ${actual[name] ?? '<missing>'}; expected ${value}`,
      );
    }
  }
}

async function writeManifest() {
  const temporary = `${manifestPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, manifestPath);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
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

async function readJSON(path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}
