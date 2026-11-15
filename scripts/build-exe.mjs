import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, '.exe-work');
const payloadDir = path.join(work, 'payload');
const outputPath = path.join(root, 'HtmlSingleFilePack.exe');
const nodePath = process.execPath;
const frameworkDir = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(frameworkDir, 'csc.exe');
const payloadZip = path.join(work, 'payload.zip');

if (process.platform !== 'win32') throw new Error('The EXE builder must run on Windows.');
if (!(await fs.stat(compiler).catch(() => null))) throw new Error('C# compiler not found: ' + compiler);
await fs.rm(work, { recursive: true, force: true });
await fs.mkdir(payloadDir, { recursive: true });
const buildScripts = [
  'build.mjs', 'build-one.mjs', 'bundle-project.mjs', 'prepare.mjs',
  'original-deflate.mjs', 'roadroller-fast-worker.mjs', 'regpack-worker.mjs',
];
const stagedScripts = path.join(payloadDir, 'scripts');
await fs.mkdir(stagedScripts, { recursive: true });
for (const name of buildScripts) {
  await fs.copyFile(path.join(root, 'scripts', name), path.join(stagedScripts, name));
}
for (const name of ['externs', 'vendor']) {
  await fs.cp(path.join(root, name), path.join(payloadDir, name), { recursive: true, dereference: true });
}
const stagedNodeModules = path.join(payloadDir, 'node_modules');
await fs.mkdir(stagedNodeModules, { recursive: true });
const copiedPackages = new Set();
async function copyPackage(sourcePath, destinationPath) {
  const realPath = await fs.realpath(sourcePath);
  if (copiedPackages.has(destinationPath)) return;
  copiedPackages.add(destinationPath);
  await fs.mkdir(destinationPath, { recursive: true });
  await fs.cp(realPath, destinationPath, {
    recursive: true,
    dereference: true,
    filter: (source) => path.basename(source).toLowerCase() !== 'node_modules',
  });
  const manifestPath = path.join(realPath, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const dependencyNames = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const storeNodeModules = realPath.slice(0, realPath.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
  for (const dependencyName of dependencyNames) {
    const dependencySource = path.join(storeNodeModules, dependencyName);
    if (!(await fs.stat(dependencySource).catch(() => null))) continue;
    await copyPackage(dependencySource, path.join(destinationPath, 'node_modules', dependencyName));
  }
}
const projectManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
for (const dependencyName of new Set([
  ...Object.keys(projectManifest.dependencies ?? {}),
  ...Object.keys(projectManifest.devDependencies ?? {}),
])) {
  await copyPackage(path.join(root, 'node_modules', dependencyName), path.join(stagedNodeModules, dependencyName));
}
await fs.copyFile(nodePath, path.join(payloadDir, 'node.exe'));

const zipResult = spawnSync('tar.exe', ['-a', '-cf', payloadZip, 'node.exe', 'scripts', 'externs', 'vendor', 'node_modules'], {
  cwd: payloadDir,
  stdio: 'inherit',
});
if (zipResult.status !== 0) throw new Error('Could not create the embedded runtime archive (exit ' + zipResult.status + ').');

const launcherSource = path.join(work, 'windows-launcher.cs');
const launcherTemplate = await fs.readFile(path.join(root, 'scripts', 'windows-launcher.cs'), 'utf8');
const runtimeVersion = crypto.createHash('sha256').update(await fs.readFile(payloadZip)).digest('hex').slice(0, 16);
await fs.writeFile(launcherSource, launcherTemplate.replace('__RUNTIME_VERSION__', runtimeVersion));
const result = spawnSync(compiler, [
  '/nologo', '/target:exe', '/optimize+', '/out:' + outputPath,
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  '/resource:' + payloadZip + ',HtmlSingleFilePack.Payload.zip', launcherSource,
], { cwd: root, stdio: 'inherit', maxBuffer: 16 * 1024 * 1024 });
if (result.status !== 0) throw new Error('C# launcher compilation failed (exit ' + result.status + ').');
const stat = await fs.stat(outputPath);
console.log('Created ' + path.relative(root, outputPath) + ' (' + (stat.size / 1024 / 1024).toFixed(1) + ' MiB).');
console.log('Run it from a folder of HTML files; output is written to .\\dist unless an output directory is specified.');
await fs.rm(work, { recursive: true, force: true });
