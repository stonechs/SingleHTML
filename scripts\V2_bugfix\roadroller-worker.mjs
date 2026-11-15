import fs from 'node:fs/promises';
import { Packer, defaultSparseSelectors } from 'roadroller';

const [inputPath, outputPath, mode = 'o1'] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: roadroller-worker.mjs input.js output.json [o1|fixed|speed]');
if (!['o1', 'fixed', 'speed'].includes(mode)) throw new Error(`Unknown Roadroller mode: ${mode}`);

const data = await fs.readFile(inputPath, 'utf8');
const options = mode === 'speed'
  ? { sparseSelectors: defaultSparseSelectors(1), maxMemoryMB: 16 }
  : {};
const packer = new Packer([{ data, type: 'js', action: 'eval' }], options);
if (mode === 'o1') await packer.optimize(1);
const packed = packer.makeDecoder();
await fs.writeFile(outputPath, JSON.stringify({
  mode,
  inputBytes: Buffer.byteLength(data, 'utf8'),
  firstLine: packed.firstLine,
  secondLine: packed.secondLine,
}), 'utf8');
