import {access, readFile, realpath, rm, symlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

const [sourceArgument, targetArgument] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error(
    'Usage: node link-local-addon.mjs <local-addon-directory> <installed-package-directory>',
  );
}

const source = resolve(sourceArgument);
const target = await realpath(resolve(targetArgument));
const [sourcePackage, installedPackage] = await Promise.all([
  readJSON(join(source, 'package.json')),
  readJSON(join(target, 'package.json')),
]);
if (
  sourcePackage.name !== '@rocicorp/zero-sqlite3' ||
  installedPackage.name !== sourcePackage.name
) {
  throw new Error(
    'Local and installed packages must be @rocicorp/zero-sqlite3',
  );
}
if (installedPackage.version !== sourcePackage.version) {
  throw new Error(
    `Local addon version ${sourcePackage.version} does not match installed version ${installedPackage.version}`,
  );
}

const dependencyRoot = dirname(dirname(target));
await access(join(dependencyRoot, 'bindings'));
await rm(join(source, 'build'), {recursive: true, force: true});
await rm(join(source, 'node_modules'), {recursive: true, force: true});
await symlink(dependencyRoot, join(source, 'node_modules'), 'dir');
await rm(target, {recursive: true});
await symlink(source, target, 'dir');
console.log(
  `Linked local @rocicorp/zero-sqlite3 ${sourcePackage.version} from ${source}`,
);

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
