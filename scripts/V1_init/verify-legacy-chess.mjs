import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { parse } from 'parse5';

function scripts(html) {
  const result = [];
  function walk(node) {
    if (node.tagName === 'script') result.push(node.childNodes.map((child) => child.value ?? '').join(''));
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html));
  return result;
}
async function run(file, packed) {
  const html = await fs.readFile(new URL(file, import.meta.url), 'utf8');
  const originalHtml = file.includes('.original.deflate.base64.') ? await fs.readFile(new URL('../examples/demo.html', import.meta.url), 'utf8') : null;
  const events = new Map(), timers = [];
  const document = {
    body: { innerHTML: '' }, open() {},
    write(text) {
      if (originalHtml !== null) {
        assert.equal(text, originalHtml);
        // Simulate the parser executing original script tags written to the document.
        for (const script of scripts(text)) vm.runInContext(script, sandbox, { timeout: 10000 });
      }
    }, close() {},
    addEventListener(name, callback) { events.set(name, callback); },
  };
  const math = Object.create(Math); math.random = () => 0.5;
  const sandbox = { document, Math: math, atob, TextDecoder, Blob, Response, DecompressionStream, setTimeout(code) { timers.push(code); } };
  vm.createContext(sandbox);
  for (const script of scripts(html)) await vm.runInContext(script, sandbox, { timeout: 10000 });
  if (packed && events.has('DOMContentLoaded')) events.get('DOMContentLoaded')();
  function snapshot() {
    assert.equal((document.body.innerHTML.match(/<th /g) ?? []).length, 64);
    return { board: Array.from(sandbox.I).slice(0, 120), html: document.body.innerHTML };
  }
  const initial = snapshot();
  for (const square of [81, 61]) {
    const handler = [...document.body.innerHTML.matchAll(/onclick='([^']+)'/g)]
      .map((match) => match[1]).find((text) => text.startsWith(`I[b=${square}]`));
    assert.ok(handler);
    vm.runInContext(handler, sandbox, { timeout: 10000 });
  }
  assert.equal(sandbox.I[81], 0);
  assert.equal(sandbox.I[61], 9);
  const moved = snapshot();
  assert.equal(timers.length, 1);
  assert.equal(typeof timers[0], 'string');
  vm.runInContext(timers.shift(), sandbox, { timeout: 10000 });
  const replied = snapshot();
  assert.notDeepEqual(replied.board, moved.board);
  return { initial, moved, replied };
}
const original = await run('../examples/demo.html', false);
for (const suffix of ['', '.base64', '.regpack.direct', '.deflate.base64', '.original.deflate.base64']) {
  assert.deepEqual(await run(`../dist/demo.single${suffix}.html`, true), original);
}
console.log('PASS: all five legacy chess outputs match source: 64 cells, dynamic onclick move, and string-timer AI reply. (Node with simulated DOM and native DecompressionStream.)');
