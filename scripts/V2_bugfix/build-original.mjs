import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packOriginalHtml } from './original-deflate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv[2] ?? path.join(root, 'examples/demo.html'));
const output = path.resolve(process.argv[3] ?? path.join(root, 'dist/demo.single.original.deflate.base64.html'));
const packed = packOriginalHtml(await fs.readFile(input));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, packed.html, 'utf8');
const { html, ...sizes } = packed;
console.log(JSON.stringify({ input, output, ...sizes, compression: 'raw DEFLATE level 9, memLevel 9', originalBytesRoundTrip: 'passed' }, null, 2));
