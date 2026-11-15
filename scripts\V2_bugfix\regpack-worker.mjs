import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cmdRegPack } = require('regpack');
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: regpack-worker.mjs input.js output.js');

const source = await fs.readFile(inputPath, 'utf8');
const packed = cmdRegPack(source, {
  reassignVars: false,
  withMath: false,
  hash2DContext: false,
  hashWebGLContext: false,
  hashAudioContext: false,
  wrapInSetInterval: false,
});
await fs.writeFile(outputPath, packed, 'utf8');
