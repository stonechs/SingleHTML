import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if ((await fs.readFile(path.join(root, 'examples/demo.html'), 'utf8')).includes('Chess in 1.25K')) {
  await import('./verify-legacy-chess.mjs');
  process.exit(0);
}
if ((await fs.readFile(path.join(root, 'examples/demo.html'), 'utf8')).includes('CHESS ENGINE LOGIC')) {
  await import('./verify-chess.mjs');
  process.exit(0);
}
const html = await fs.readFile(path.join(root, 'dist/demo.single.html'), 'utf8');
const outputTree = parse(html);
const runtimeScripts = [];
function collectScripts(node) {
  if (node.tagName === 'script') runtimeScripts.push(node.childNodes.map((child) => child.value ?? '').join(''));
  for (const child of node.childNodes ?? []) collectScripts(child);
}
collectScripts(outputTree);
assert.equal(runtimeScripts.length, 1, 'output should have one runtime script');
assert.equal((runtimeScripts[0].match(/Function\(/g) ?? []).length, 1, 'output should have one Roadroller decoder');
assert.equal((runtimeScripts[0].match(/\\u00[0-9a-fA-F]{2}/g) ?? []).length, 0, 'Base122 data should not expand into Unicode control escapes');

const elements = new Map();
const listeners = new Map();
const written = [];
function makeElement(id) {
  const handlers = new Map();
  const attributes = new Map();
  const element = {
    id,
    textContent: '',
    addEventListener(name, callback) { handlers.set(name, callback); },
    click() { handlers.get('click')?.({ target: element }); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
  elements.set(id, element);
  return element;
}
makeElement('run');
makeElement('result');
const document = {
  open() {},
  write(value) { written.push(value); },
  close() {},
  addEventListener(name, callback) { listeners.set(name, callback); },
  getElementById(id) { return elements.get(id) ?? null; },
};
const sandbox = { document, console, atob, TextDecoder, Response, DecompressionStream, Date, URL, Blob, Uint8Array, Object, Math, JSON, String, Array };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(runtimeScripts[0], sandbox, { filename: 'generated-runtime.js', timeout: 5000 });

assert.equal(written.length, 1, 'the combined bundle should print static HTML once');
const printedTree = parse(written[0]);
const printedScriptCount = [];
function inspectPrinted(node) {
  if (node.tagName === 'script') {
    const type = node.attrs?.find(({ name }) => name === 'type')?.value?.toLowerCase() ?? '';
    if (!type || ['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(type)) printedScriptCount.push(node);
  }
  for (const child of node.childNodes ?? []) inspectPrinted(child);
}
inspectPrinted(printedTree);
assert.equal(printedScriptCount.length, 0, 'executable inline scripts should be removed from printed HTML');
assert.match(written[0], /<style>/);
assert.equal(typeof listeners.get('DOMContentLoaded'), 'function');
listeners.get('DOMContentLoaded')();
assert.equal(elements.get('result').textContent, 'Page script loaded; click the button.');
elements.get('run').click();
assert.match(elements.get('result').textContent, /^Packed script ran offline at /);
assert.equal(elements.get('result').getAttribute('data-ran'), 'yes');
const base64Html = await fs.readFile(path.join(root, 'dist/demo.single.base64.html'), 'utf8');
runtimeScripts.length = 0;
collectScripts(parse(base64Html));
assert.equal(runtimeScripts.length, 1);
written.length = 0;
vm.runInContext(runtimeScripts[0], sandbox, { timeout: 5000 });
assert.equal(written.length, 1);
listeners.get('DOMContentLoaded')();
assert.equal(elements.get('result').textContent, 'Page script loaded; click the button.');
elements.get('run').click();
assert.equal(elements.get('result').getAttribute('data-ran'), 'yes');
runtimeScripts.length = 0;
collectScripts(parse(await fs.readFile(path.join(root, 'dist/demo.single.regpack.direct.html'), 'utf8')));
assert.equal(runtimeScripts.length, 1);
written.length = 0;
vm.runInContext(runtimeScripts[0], sandbox, { timeout: 5000 });
assert.equal(written.length, 1);
listeners.get('DOMContentLoaded')();
elements.get('run').click();
assert.equal(elements.get('result').getAttribute('data-ran'), 'yes');
runtimeScripts.length = 0;
collectScripts(parse(await fs.readFile(path.join(root, 'dist/demo.single.deflate.base64.html'), 'utf8')));
assert.equal(runtimeScripts.length, 1);
written.length = 0;
await vm.runInContext(runtimeScripts[0], sandbox, { timeout: 5000 });
assert.equal(written.length, 1);
listeners.get('DOMContentLoaded')();
elements.get('run').click();
assert.equal(elements.get('result').getAttribute('data-ran'), 'yes');
console.log('PASS: all four versions decoded, printed HTML once, and ran the demo button.');
