import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const fullGitObject = /^[0-9a-f]{40}$/;
const digestReference = /@sha256:[0-9a-f]{64}$/;

export async function inspectGitSource(cwd) {
  const commit = capture('git', ['rev-parse', 'HEAD'], cwd).trim();
  const tree = capture('git', ['rev-parse', 'HEAD^{tree}'], cwd).trim();
  const trackedContentSHA256 = gitTrackedContentSHA256(cwd);
  const status = capture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    cwd,
  ).trim();
  const trackedDiff = capture('git', ['diff', '--binary', 'HEAD'], cwd);
  const untrackedPaths = capture(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd,
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const untracked = await Promise.all(
    untrackedPaths.map(async path => ({
      path,
      sha256: sha256(await readFile(join(cwd, path))),
    })),
  );
  const diffHash = createHash('sha256').update(trackedDiff);
  for (const file of untracked) {
    diffHash.update('\0');
    diffHash.update(file.path);
    diffHash.update('\0');
    diffHash.update(file.sha256);
  }
  const diffSHA256 = diffHash.digest('hex');
  return {
    path: cwd,
    commit,
    tree,
    clean: status === '',
    status,
    diffSHA256,
    trackedDiffSHA256: sha256(trackedDiff),
    trackedContentSHA256,
    contentSHA256: sha256(`${trackedContentSHA256}\0${diffSHA256}`),
    untracked,
  };
}

export function assertCanonicalSource(
  label,
  source,
  expectedCommit,
  expectedTree,
) {
  if (!fullGitObject.test(expectedCommit ?? '')) {
    throw new Error(`${label} expected commit must be a full 40-character ID`);
  }
  if (!fullGitObject.test(expectedTree ?? '')) {
    throw new Error(`${label} expected tree must be a full 40-character ID`);
  }
  if (source.commit !== expectedCommit) {
    throw new Error(
      `${label} is at ${source.commit}; expected ${expectedCommit}`,
    );
  }
  if (source.tree !== expectedTree) {
    throw new Error(
      `${label} has tree ${source.tree}; expected ${expectedTree}`,
    );
  }
  if (!source.clean) {
    throw new Error(
      `${label} has dirty or untracked product source:\n${source.status}`,
    );
  }
}

export function requireDigestReference(label, reference) {
  if (!digestReference.test(reference ?? '')) {
    throw new Error(
      `${label} must be an immutable name@sha256:<64 hex characters> reference`,
    );
  }
  return reference;
}

export function inspectDockerImage(reference, cwd) {
  const [image] = JSON.parse(
    capture('docker', ['image', 'inspect', reference], cwd),
  );
  return {
    reference,
    id: image.Id,
    repoDigests: image.RepoDigests ?? [],
    created: image.Created,
    os: image.Os,
    architecture: image.Architecture,
    variant: image.Variant ?? null,
    labels: image.Config?.Labels ?? {},
    rootFSLayers: image.RootFS?.Layers ?? [],
  };
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export function gitTrackedContentSHA256(cwd, paths = []) {
  return sha256(
    capture(
      'git',
      [
        'ls-tree',
        '-r',
        '--full-tree',
        '-z',
        'HEAD',
        ...(paths.length ? ['--', ...paths] : []),
      ],
      cwd,
    ),
  );
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
}
