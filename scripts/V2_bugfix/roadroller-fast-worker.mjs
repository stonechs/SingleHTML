import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor/roadroller-fast');
const [inputPath, outputPath, mode = 'fixed', contextsValue = '12'] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: roadroller-fast-worker.mjs input.js output.json [o1|fixed] [contexts]');
if (!['o1', 'fixed'].includes(mode)) throw new Error(`Unknown Roadroller mode: ${mode}`);
const contexts = Number(contextsValue);
if (!Number.isInteger(contexts) || contexts < 1 || contexts > 64) throw new Error('Contexts must be an integer from 1 to 64.');

const sandbox = { TextDecoder, TextEncoder, performance, WebAssembly, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
for (const file of ['js-token.js', 'wasm.js', 'deflate.js', 'index.js']) {
  vm.runInContext(await fs.readFile(path.join(vendor, file), 'utf8'), sandbox, { filename: file });
}
vm.runInContext('globalThis.FastPacker=Packer;globalThis.fastDefaultSparseSelectors=defaultSparseSelectors;', sandbox);

const data = await fs.readFile(inputPath, 'utf8');
const maxMemoryMB = 150;
const packer = new sandbox.FastPacker([{ data, type: 'js', action: 'eval' }], {
  sparseSelectors: sandbox.fastDefaultSparseSelectors(contexts),
  maxMemoryMB,
  exe: 0,
});
if (mode === 'o1') await packer.optimize(1);
const packed = packer.makeDecoder();
await fs.writeFile(outputPath, JSON.stringify({
  mode,
  decoderMode: 'roadroller-small-generated',
  contexts,
  maxMemoryMB,
  inputBytes: Buffer.byteLength(data, 'utf8'),
  firstLine: packed.firstLine,
  secondLine: packed.secondLine,
}), 'utf8');
