import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.resolve(process.argv[2] ?? path.join(root, 'examples/demo.html')));
const html = await fs.readFile(path.resolve(process.argv[3] ?? path.join(root, 'dist/demo.single.original.deflate.base64.html')), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const payload = script.match(/atob\("([A-Za-z0-9+/=]+)"\)/)[1];
const restored = await new Response(new Blob([Buffer.from(payload, 'base64')]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
assert.ok(Buffer.from(restored).equals(source), 'native decompression must restore every original byte');
const calls = [];
const document = { open() { calls.push('open'); }, write(text) { calls.push(text); }, close() { calls.push('close'); } };
await vm.runInNewContext(script, { document, atob, Blob, Response, DecompressionStream });
assert.deepEqual(calls, ['open', new TextDecoder().decode(source), 'close']);
console.log('PASS: native raw DEFLATE restores exact original bytes; standalone loader writes the original HTML without evaluating or rewriting it.');
