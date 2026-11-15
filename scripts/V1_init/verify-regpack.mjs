import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { parse } from 'parse5';

for (const suffix of ['', '.base64', '.regpack.direct', '.deflate.base64']) {
  const html = await fs.readFile(new URL(`../dist/regpack-demo${suffix}.html`, import.meta.url), 'utf8');
  const scripts = [];
  function walk(node) {
    if (node.tagName === 'script') scripts.push(node.childNodes.map((child) => child.value ?? '').join(''));
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html));
  assert.equal(scripts.length, 1);
  const elements = { go: {}, out: {} }, listeners = new Map(), writes = [];
  const document = {
    open() {}, close() {}, write(html) { writes.push(html); },
    getElementById(id) { return elements[id]; },
    addEventListener(name, fn) { listeners.set(name, fn); },
  };
  await vm.runInNewContext(scripts[0], { document, atob, TextDecoder, Blob, Response, DecompressionStream }, { timeout: 5000 });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /<button id="go">/);
  listeners.get('DOMContentLoaded')();
  elements.go.onclick();
  assert.equal(elements.out.textContent, '你好，RegPack ✓');
}
console.log('PASS: all four versions print markup and run the Unicode button action. (Node with simulated DOM.)');
