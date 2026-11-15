import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oneFileBuilder = path.join(root, 'scripts/build-one.mjs');
const buildTimeoutMs = 180_000;

function childFailure(result, action) {
  if (result.error?.code === 'ETIMEDOUT') {
    return `${action} timed out after ${buildTimeoutMs / 1000} seconds.`;
  }
  if (result.error) return `${action} failed to start: ${result.error.message}`;
  return `${action} failed (exit ${result.status ?? 'unknown'}).`;
}

// Supplying arguments retains the one-file interface:
//   node scripts/build.mjs input.html [output.html]
if (process.argv.length > 2) {
  const explicitArgs = process.argv.slice(2);
  if (explicitArgs.length === 1) {
    const input = path.resolve(explicitArgs[0]);
    const folder = path.parse(input).name;
    explicitArgs.push(path.join(root, 'dist', folder, `${folder}.single.html`));
  }
  const result = spawnSync(process.execPath, [oneFileBuilder, ...explicitArgs], {
    cwd: root,
    stdio: 'inherit',
    timeout: buildTimeoutMs,
  });
  if (result.error || result.status !== 0) {
    console.error(childFailure(result, 'Build'));
    process.exitCode = result.status ?? 1;
  }
} else {
  const inputDir = path.resolve(process.env.HTMLPACK_INPUT_DIR ?? path.join(root, 'input'));
  const outputRoot = path.resolve(process.env.HTMLPACK_OUTPUT_DIR ?? path.join(root, 'dist'));
  const ignoredDirectories = new Set([
    '.git', '.build-work', '.bundle-work', '.exe-work', 'dist', 'node_modules',
    'scripts', 'externs', 'vendor', 'examples',
  ]);
  async function collectHtmlFiles(directory, relativeDirectory = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    const files = [];
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase())) {
        files.push(...await collectHtmlFiles(absolutePath, relativePath));
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        files.push(relativePath);
      }
    }
    return files;
  }
  const rootEntries = (await fs.readdir(inputDir, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const inputs = [];
  for (const entry of rootEntries) {
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name.toLowerCase()) || path.resolve(inputDir, entry.name) === outputRoot)) continue;
    if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      inputs.push({ type: 'file', name: entry.name, relativePath: entry.name });
    } else if (entry.isDirectory()) {
      const projectDir = path.join(inputDir, entry.name);
      const htmlFiles = await collectHtmlFiles(projectDir);
      const rootIndex = htmlFiles.find((relativePath) => path.dirname(relativePath) === '.' && /^index\.html?$/i.test(path.basename(relativePath)));
      if (rootIndex) {
        inputs.push({ type: 'project', name: entry.name, projectDir, entryPath: path.join(projectDir, rootIndex) });
      } else if (htmlFiles.length === 1) {
        inputs.push({ type: 'project', name: entry.name, projectDir, entryPath: path.join(projectDir, htmlFiles[0]) });
      } else if (htmlFiles.length > 1) {
        inputs.push({ type: 'error', name: entry.name, error: `contains ${htmlFiles.length} HTML files but no root index.html` });
      } else {
        console.warn(`Skipping ${entry.name}: no .html or .htm entry file found.`);
      }
    }
  }

  if (inputs.length === 0) {
    throw new Error(`No .html or .htm files found in ${inputDir}`);
  }

  const folders = new Map();
  for (const item of inputs) {
    const relativeFolder = item.type === 'project' || item.type === 'error'
      ? item.name
      : path.parse(item.name).name;
    const key = relativeFolder.toLowerCase();
    if (folders.has(key)) {
      throw new Error(`Inputs produce the same output folder: ${folders.get(key)} and ${item.name}`);
    }
    folders.set(key, item.name);
  }

  let failures = 0;
  const bundleWorkRoot = path.join(root, '.bundle-work');
  console.log(`Building ${inputs.length} input(s) from ${path.relative(root, inputDir)}. Each child directory is bundled as one project.\n`);
  for (const item of inputs) {
    const folder = item.type === 'project' || item.type === 'error' ? item.name : path.parse(item.name).name;
    const outputDir = path.join(outputRoot, folder);
    if (item.type === 'error') {
      failures++;
      console.error(`\n=== ${item.name} ===\nCannot build project: ${item.error}. Use index.html as the entry or leave only one HTML file.`);
      continue;
    }
    let input;
    if (item.type === 'project') {
      input = path.join(bundleWorkRoot, folder, path.basename(item.entryPath));
      const bundleResult = spawnSync(process.execPath, [
        path.join(root, 'scripts/bundle-project.mjs'), item.projectDir, item.entryPath, input,
      ], { cwd: root, stdio: 'inherit', timeout: buildTimeoutMs });
      if (bundleResult.error || bundleResult.status !== 0) {
        failures++;
        console.error(childFailure(bundleResult, `Bundling project ${item.name}`));
        continue;
      }
    } else {
      input = path.join(inputDir, item.name);
    }
    const outputName = item.type === 'project' ? `${folder}.html` : `${folder}.single.html`;
    const output = path.join(outputDir, outputName);
    console.log(`\n=== ${item.type === 'project' ? `${item.name}/ (${path.relative(item.projectDir, item.entryPath)})` : item.name} -> ${path.relative(root, outputDir)} ===`);
    console.log(`Per-input build timeout: ${buildTimeoutMs / 1000} seconds.`);
    const result = spawnSync(process.execPath, [oneFileBuilder, input, output], {
      cwd: root,
      stdio: 'inherit',
      timeout: buildTimeoutMs,
    });
    if (result.error || result.status !== 0) {
      failures++;
      console.error(childFailure(result, `Build for ${item.name}`));
    } else if (item.type === 'project') {
      await fs.rm(path.join(outputDir, path.basename(item.entryPath)), { force: true });
      await fs.copyFile(input, path.join(outputDir, `${folder}.unoptimized.html`));
    }
  }

  console.log(`\nBatch complete: ${inputs.length - failures}/${inputs.length} succeeded.`);
  await fs.rm(bundleWorkRoot, { recursive: true, force: true });
  if (failures) process.exitCode = 1;
}
