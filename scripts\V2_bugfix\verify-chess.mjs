import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'parse5';

const source = await fs.readFile(new URL('../examples/demo.html', import.meta.url), 'utf8');
const output = await fs.readFile(new URL('../dist/demo.single.html', import.meta.url), 'utf8');
const base64Output = await fs.readFile(new URL('../dist/demo.single.base64.html', import.meta.url), 'utf8');
const regpackOutput = await fs.readFile(new URL('../dist/demo.single.regpack.direct.html', import.meta.url), 'utf8');
function scripts(html) {
  const result = [];
  function walk(node) {
    if (node.tagName === 'script') result.push(node.childNodes.map((child) => child.value ?? '').join(''));
    for (const child of node.childNodes ?? []) walk(child);
  }
  walk(parse(html));
  return result;
}
async function run(html, packed) {
  const elements = new Map(), events = new Map(), timers = [];
  function element(id) {
    let text = '';
    const node = {
      children: [], className: '', value: '1', style: {},
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(name, callback) { this['on' + name] = callback; },
      click() { this.onclick?.({ target: this }); },
      set innerHTML(value) { this.children = []; text = String(value); },
      get innerHTML() { return text; },
      set innerText(value) { text = String(value); },
      get innerText() { return text; },
      set textContent(value) { text = String(value); },
      get textContent() { return text; },
    };
    node.classList = { add(...names) { node.className += ' ' + names.join(' '); } };
    if (id) elements.set(id, node);
    return node;
  }
  for (const id of ['board', 'status', 'difficulty']) element(id);
  const document = {
    open() {}, close() {}, write(value) { assert.match(value, /JS Chess/); },
    addEventListener(name, callback) { events.set(name, callback); },
    getElementById(id) { return elements.get(id); }, createElement() { return element(); },
  };
  const math = Object.create(Math); math.random = () => 0.5;
  const sandbox = { document, console, atob, TextDecoder, Blob, Response, DecompressionStream, Math: math, setTimeout(callback) { timers.push(callback); } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts(html)) await vm.runInContext(script, sandbox, { timeout: 10000 });
  if (packed) events.get('DOMContentLoaded')();
  function snapshot() {
    const squares = elements.get('board').children;
    assert.equal(squares.length, 64);
    const pieces = squares.flatMap((square) => square.children);
    assert.equal(pieces.length, 32);
    for (const piece of pieces) assert.match(piece.innerText, /^[♟♜♞♝♛♚]$/u);
    return { cells: squares.map((square) => square.children[0]?.innerText ?? ''), status: elements.get('status').innerText };
  }
  const initial = snapshot();
  elements.get('board').children[52].click();
  elements.get('board').children[36].click();
  const moved = snapshot();
  assert.equal(moved.cells[52], ''); assert.equal(moved.cells[36], '♟');
  assert.equal(timers.length, 1, 'white move should schedule the AI');
  timers.shift()();
  const replied = snapshot();
  assert.notDeepEqual(replied.cells, moved.cells);
  assert.equal(typeof sandbox.newGame, 'function', 'HTML New Game handler must remain global');
  sandbox.newGame();
  assert.deepEqual(snapshot(), initial);
  return { initial, moved, replied };
}
assert.equal(scripts(output).length, 1);
const original = await run(source, false);
assert.deepEqual(await run(output, true), original);
assert.equal(scripts(base64Output).length, 1);
assert.deepEqual(await run(base64Output, true), original);
assert.equal(scripts(regpackOutput).length, 1);
assert.deepEqual(await run(regpackOutput, true), original);
const deflateOutput = await fs.readFile(new URL('../dist/demo.single.deflate.base64.html', import.meta.url), 'utf8');
assert.equal(scripts(deflateOutput).length, 1);
assert.deepEqual(await run(deflateOutput, true), original);
console.log('PASS: all four versions match source: 32 glyphs, e2-e4, AI reply, and global New Game reset. (Node with simulated DOM.)');
