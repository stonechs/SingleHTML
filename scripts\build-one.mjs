import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { parse as parseJavaScript } from 'acorn';
import { createRequire } from 'node:module';
import { parse } from 'parse5';
import { minify as minifyJavaScript } from 'terser';
import { browserslistToTargets, transform as transformCss } from 'lightningcss';
import { prepareJavaScript } from './prepare.mjs';
import { packOriginalHtml } from './original-deflate.mjs';
import { compress as compressLzma, decompress as decompressLzma } from 'lzma1';

const require = createRequire(import.meta.url);
const base122 = require('../vendor/base122.cjs');
const { cmdRegPack } = require('regpack');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.resolve(process.argv[2] ?? path.join(root, 'examples/demo.html'));
const outputPath = path.resolve(process.argv[3] ?? path.join(root, 'dist/demo.single.html'));
const sourceCopyPath = path.join(path.dirname(outputPath), path.basename(inputPath));
const workDir = path.join(root, '.build-work');
const regpackWorker = path.join(root, 'scripts/regpack-worker.mjs');
const roadrollerWorker = path.join(root, 'scripts/roadroller-fast-worker.mjs');
const regpackMaxInputBytes = 8 * 1024;
const regpackTimeoutMs = 2500;
const roadrollerTimeoutMs = 120_000;
const roadrollerO1MaxInputBytes = 300_000;
const roadrollerTwelveContextMaxInputBytes = 500_000;
const roadrollerMaxInputBytes = 1_500_000;
const roadrollerFastPlusMinInputBytes = 300_000;
const cssTargets = browserslistToTargets(['chrome 120', 'safari 17', 'firefox 121']);
const buildStartedAt = performance.now();
const phaseTimesMs = {};
const compilerCli = path.join(root, 'node_modules/google-closure-compiler/cli.js');
const bootstrapPath = path.join(root, 'vendor/base122-browser-runtime.js');
const lzmaDecoderPath = path.join(root, 'vendor/lzma-small-decoder.js');
const externDir = path.join(root, 'externs');
const inputBytes = await fs.readFile(inputPath);
await fs.mkdir(path.dirname(sourceCopyPath), { recursive: true });
if (path.resolve(sourceCopyPath) !== inputPath) await fs.copyFile(inputPath, sourceCopyPath);
const obsoleteRegpackBase64Path = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.regpack.base64.html') : outputPath + '.regpack.base64.html';
await fs.rm(obsoleteRegpackBase64Path, { force: true });
let phaseStartedAt = performance.now();
const originalPacked = packOriginalHtml(inputBytes);
phaseTimesMs.originalDeflatePack = performance.now() - phaseStartedAt;
const originalOutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.original.deflate.base64.html') : outputPath + '.original.deflate.base64.html';
await fs.mkdir(path.dirname(originalOutputPath), { recursive: true });
await fs.writeFile(originalOutputPath, originalPacked.html, 'utf8');
const originalDeflateBytes = deflateRawSync(inputBytes, { level: 9, memLevel: 9 });
const originalBase122 = Buffer.from(base122.encode(originalDeflateBytes)).toString('utf8');
if (!inflateRawSync(Buffer.from(base122.decode(originalBase122))).equals(inputBytes)) {
  throw new Error('Original DEFLATE+Base122 round-trip failed.');
}
const originalBase122Source = `(function(){function d(s){var o=[],p=0,b=0,x=[0,10,13,34,38,92];function q(v){p=p<<7|v;b+=7;if(b>=8){b-=8;o.push(p>>>b&255)}}for(var i=0;i<s.length;i++){var c=s.charCodeAt(i),n=c>>>8&7;if(c>127&&n!==7)q(x[n]);q(c&127)}return o}var z=d('__HTMLPACK_PAYLOAD__');new Response(new Blob([Uint8Array.from(z)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text().then(function(s){document.open();document.write(s);document.close()})})();`;
const originalBase122InputPath = path.join(workDir, 'input-original-deflate-base122-loader.js');
const originalBase122ClosurePath = path.join(workDir, 'closure-original-deflate-base122-loader.js');
await fs.writeFile(originalBase122InputPath, originalBase122Source, 'utf8');
phaseStartedAt = performance.now();
phaseTimesMs.originalDeflateBase122LoaderClosure = runClosureOnce(originalBase122InputPath, originalBase122ClosurePath);
let originalBase122Loader = await fs.readFile(originalBase122ClosurePath, 'utf8');
const originalBase122Marker = /["']__HTMLPACK_PAYLOAD__["']/;
if (!originalBase122Marker.test(originalBase122Loader)) throw new Error('Original DEFLATE+Base122 payload marker was lost during loader optimization.');
const originalBase122Literal = `\`${originalBase122.replace(/<\/script/gi, '\\x3c/script').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
originalBase122Loader = originalBase122Loader.replace(originalBase122Marker, () => originalBase122Literal).trim();
const originalBase122Html = `<!doctype html><meta charset="utf-8"><script>${originalBase122Loader}</script>`;
const originalBase122OutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.original.deflate.base122.html') : outputPath + '.original.deflate.base122.html';
phaseStartedAt = performance.now();
await fs.writeFile(originalBase122OutputPath, originalBase122Html, 'utf8');
phaseTimesMs.originalDeflateBase122Packaging = performance.now() - phaseStartedAt;
const html = inputBytes.toString('utf8');
phaseStartedAt = performance.now();
const documentTree = parse(html, { sourceCodeLocationInfo: true });
const scriptNodes = [];
const styleNodes = [];
const unsupportedResources = [];
const htmlHandlers = [];

function walk(node) {
  if (node.tagName === 'script' && node.sourceCodeLocation) scriptNodes.push(node);
  if (node.tagName === 'style' && node.sourceCodeLocation) styleNodes.push(node);
  if (node.tagName) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on[a-z]+$/.test(name)) htmlHandlers.push(value);
      if (name === 'href' && /^javascript:/i.test(value)) htmlHandlers.push(value.slice(value.indexOf(':') + 1));
    }
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    const resourceAttrs = {
      script: ['src'], link: rel.some((value) => ['stylesheet', 'icon', 'preload', 'modulepreload', 'manifest'].includes(value)) ? ['href'] : [],
      img: ['src', 'srcset'], source: ['src', 'srcset'], audio: ['src'], video: ['src', 'poster'],
      iframe: ['src'], embed: ['src'], object: ['data'], track: ['src'], input: attrs.type === 'image' ? ['src'] : [],
    }[node.tagName] ?? [];
    for (const name of resourceAttrs) {
      if (attrs[name] && !/^data:/i.test(attrs[name])) unsupportedResources.push(`<${node.tagName} ${name}="${attrs[name]}">`);
    }
    for (const css of [attrs.style ?? '', node.tagName === 'style' ? (node.childNodes ?? []).map((child) => child.value ?? '').join('') : '']) {
      if (/@import\s+(?!url\(\s*['"]?data:)|url\(\s*['"]?(?!data:|#)/i.test(css)) {
        unsupportedResources.push(`<${node.tagName}> CSS url()/@import`);
      }
    }
  }
  for (const child of node.childNodes ?? []) walk(child);
  if (node.content) walk(node.content);
}
walk(documentTree);
if (unsupportedResources.length) {
  throw new Error(`Offline output requires embedded resources. Inline these external or relative resources first:\n${[...new Set(unsupportedResources)].map((value) => `- ${value}`).join('\n')}`);
}

const activeScripts = [];
for (const node of scriptNodes) {
  const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name.toLowerCase(), value]));
  if ('src' in attrs) continue;
  const type = (attrs.type ?? '').trim().toLowerCase();
  if (type && type !== 'module' && !['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(type)) continue;
  const { startTag, endTag } = node.sourceCodeLocation;
  if (!startTag || !endTag) continue;
  const code = html.slice(startTag.endOffset, endTag.startOffset);
  if (type === 'module') {
    // Project bundling may inline a module-tagged script whose contents are
    // classic-compatible (for example, a self-contained eval(Function(...))
    // loader). Let the optimizer consume it, while the unoptimized copy keeps
    // the original module tag and its deferred execution semantics.
    try {
      parseJavaScript(code, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch {
      throw new Error('Inline <script type="module"> uses ESM-only syntax; bundle its imports into a classic script first.');
    }
  }
  if (code.trim()) activeScripts.push({ node, code, start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset });
}

// Minify embedded styles, then remove executable scripts from the static markup.
let staticHtml = html;
let cssInputBytes = 0;
let cssOutputBytes = 0;
const staticEdits = activeScripts.map((script) => ({ start: script.start, end: script.end, replacement: '' }));
for (const style of styleNodes) {
  const { startTag, endTag } = style.sourceCodeLocation;
  if (!startTag || !endTag) continue;
  const css = html.slice(startTag.endOffset, endTag.startOffset);
  // Some HTML generators insert standalone HTML comments into <style> blocks.
  // Browsers tolerate these in legacy cases, but Lightning CSS correctly rejects
  // their non-CSS text. Remove only whole-line HTML comments before minifying.
  const cssForMinification = css.replace(/^[\t ]*<!--[\s\S]*?-->[\t ]*$/gm, '');
  const minified = transformCss({ filename: inputPath, code: Buffer.from(cssForMinification, 'utf8'), minify: true, targets: cssTargets }).code.toString();
  cssInputBytes += Buffer.byteLength(css, 'utf8');
  cssOutputBytes += Buffer.byteLength(minified, 'utf8');
  staticEdits.push({ start: startTag.endOffset, end: endTag.startOffset, replacement: minified });
}
for (const edit of staticEdits.sort((a, b) => b.start - a.start)) {
  staticHtml = staticHtml.slice(0, edit.start) + edit.replacement + staticHtml.slice(edit.end);
}

const safeJson = (value) => JSON.stringify(value)
  .replace(/<\/script/gi, '<\\/script')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const jsTemplate = (value) => `\`${value.replace(/<\/script/gi, '\\x3c/script').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
const appStatements = activeScripts.map(({ code }) => code).join('\n;\n');
const sourceJavaScriptBytes = Buffer.byteLength(appStatements, 'utf8');
const directAppSource = [
  'document.open();',
  `document.write(${safeJson(staticHtml)});`,
  appStatements,
  'document.close();',
].join('\n');
const makeAppSource = (statements) => [
  'document.open();',
  `document.write(${safeJson(staticHtml)});`,
  // Keep application globals inside a block so names such as `history` can
  // shadow browser globals without triggering Closure's top-level redeclare
  // error. prepareJavaScript explicitly exports bindings needed by HTML APIs.
  `{\n${statements}\n}`,
  'document.close();',
].join('\n');
const protection = {};
const preparedStatements = prepareJavaScript(appStatements, htmlHandlers, protection);
const appSource = makeAppSource(preparedStatements);
// A script whose application source is hidden behind eval(variable) cannot be
// safely transformed by Closure: the compiler only sees the decoder. If the
// document has no static application markup, the generated code also relies on
// document.write running at the original parser position. Keep this predicate
// conservative and use the exact input as the main output only when Closure
// makes that opaque script larger.
const hasOpaqueDynamicEval = activeScripts.some(({ code }) =>
  /\beval\s*\(\s*[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*\s*\)/u.test(code));
const staticDocument = parse(staticHtml);
function hasStaticApplicationContent(node) {
  if (node.nodeName === '#text' && (node.value ?? '').trim()) return true;
  if (node.tagName && !['html', 'head', 'body'].includes(node.tagName)) return true;
  return (node.childNodes ?? []).some(hasStaticApplicationContent);
}
const hasStaticApplicationMarkup = hasStaticApplicationContent(staticDocument);
phaseTimesMs.htmlParseAndAssemble = performance.now() - phaseStartedAt;

await fs.rm(workDir, { recursive: true, force: true });
await fs.mkdir(workDir, { recursive: true });
async function runRegPackWithTimeout(source, label) {
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  if (sourceBytes > regpackMaxInputBytes) {
    return { code: null, reason: `input is ${sourceBytes} bytes; limit is ${regpackMaxInputBytes} bytes` };
  }
  const input = path.join(workDir, `${label}-input.js`);
  const output = path.join(workDir, `${label}-output.js`);
  await fs.writeFile(input, source, 'utf8');
  await fs.rm(output, { force: true });
  const result = spawnSync(process.execPath, [regpackWorker, input, output], {
    cwd: root,
    encoding: 'utf8',
    timeout: regpackTimeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error?.code === 'ETIMEDOUT') return { code: null, reason: `TIMEOUT after ${regpackTimeoutMs} ms` };
  if (result.error) return { code: null, reason: result.error.message };
  if (result.status !== 0) return { code: null, reason: (result.stderr || result.stdout || `worker exited ${result.status}`).trim() };
  return { code: await fs.readFile(output, 'utf8'), reason: null };
}
async function runRoadrollerWithTimeout(source) {
  const inputBytes = Buffer.byteLength(source, 'utf8');
  if (inputBytes > roadrollerMaxInputBytes) {
    return { packed: null, reason: `input is ${inputBytes} bytes; Roadroller limit is ${roadrollerMaxInputBytes} bytes`, mode: 'skipped', inputBytes, contexts: null, elapsedMs: 0 };
  }
  const contexts = inputBytes <= roadrollerTwelveContextMaxInputBytes ? 12 : 8;
  const mode = inputBytes < roadrollerO1MaxInputBytes ? 'o1' : 'fixed';
  const input = path.join(workDir, 'roadroller-input.js');
  const output = path.join(workDir, 'roadroller-output.json');
  await fs.writeFile(input, source, 'utf8');
  await fs.rm(output, { force: true });
  console.log(mode === 'o1'
    ? `Roadroller input is ${inputBytes} bytes; running O1 with ${contexts} contexts.`
    : `Roadroller input is ${inputBytes} bytes; using fixed parameters with ${contexts} contexts.`);
  const roadrollerStartedAt = performance.now();
  const result = spawnSync(process.execPath, [roadrollerWorker, input, output, mode, String(contexts)], {
    cwd: root,
    encoding: 'utf8',
    timeout: roadrollerTimeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const elapsedMs = performance.now() - roadrollerStartedAt;
  if (result.error?.code === 'ETIMEDOUT') return { packed: null, reason: `TIMEOUT after ${roadrollerTimeoutMs} ms`, mode, inputBytes, contexts, elapsedMs };
  if (result.error) return { packed: null, reason: result.error.message, mode, inputBytes, contexts, elapsedMs };
  if (result.status !== 0) return { packed: null, reason: (result.stderr || result.stdout || `worker exited ${result.status}`).trim(), mode, inputBytes, contexts, elapsedMs };
  return { packed: JSON.parse(await fs.readFile(output, 'utf8')), reason: null, mode, inputBytes, contexts, elapsedMs };
}
function makeFastPlusDecoder(packed, contexts) {
  const parameter = packed.secondLine.match(/^,\.\.\.'([^']+)',/);
  if (!parameter) throw new Error('Unexpected Roadroller fast++ parameter format.');
  let decoder = `(0,eval)(Function("[M",...${JSON.stringify(parameter[1])},${packed.secondLine.slice(parameter[0].length)}`;
  if (!decoder.includes('M.charCodeAt(d++)&63') || !decoder.includes(')([],')) throw new Error('Unexpected Roadroller fast++ reader format.');
  decoder = decoder.replace('M.charCodeAt(d++)&63', '(M[d*3>>2]<<8|M[(d*3>>2)+1])>>(10-(d++*6&7))&63').replace(')([],', ')([bytes],');
  const selector = packed.secondLine.match(/for\((\w+) of'([0-9]+)'\.split\((\w+)=0\)\)/);
  if (!selector) throw new Error('Could not find Roadroller context selector list.');
  const [, iterator, selectorDigits, zeroVariable] = selector;
  const groups = selectorDigits.split('0');
  if (groups.length !== contexts) throw new Error(`Roadroller produced ${groups.length} contexts; expected ${contexts}.`);
  const loopStart = decoder.indexOf(`for(${iterator} of'`);
  const loopEnd = decoder.indexOf(`for(${zeroVariable}=~`, loopStart);
  if (loopStart < 0 || loopEnd < 0) throw new Error('Could not locate Roadroller context loop for fast++ expansion.');
  let expanded;
  if (packed.secondLine.includes('U[t]=')) {
    const indexStart = packed.secondLine.indexOf('U[t]=');
    const indexEnd = packed.secondLine.indexOf(']+1', indexStart);
    if (indexStart < 0 || indexEnd < 0) throw new Error('Could not locate Roadroller context index expression.');
    const contextIndex = packed.secondLine.slice(indexStart + 5, indexEnd);
    expanded = 't=0,y=0;';
    for (const group of groups) {
      expanded += 'f=0;';
      for (const offset of group) expanded += `f=f*997+(c[e-${offset}]|0)|0;`;
      expanded += `f=2*r[U[t]=${contextIndex}]+1,i[t]=f=Math.log(f/(h-f)),y-=f*a[t++];`;
    }
  } else {
    const indexStart = packed.secondLine.indexOf('r[', loopStart);
    const indexEnd = packed.secondLine.indexOf(']+1', indexStart);
    if (indexStart < 0 || indexEnd < 0) throw new Error('Could not locate optimized Roadroller context index expression.');
    const contextIndex = packed.secondLine.slice(indexStart + 2, indexEnd);
    expanded = `${zeroVariable}=0;`;
    for (const group of groups) {
      expanded += 'p=0;';
      for (const offset of group) expanded += `p=p*997+(c[e-${offset}]|0)|0;`;
      expanded += `p=2*r[${contextIndex}]+1,U[A]=p=Math.log(p/(h-p)),${zeroVariable}-=p*a[A++];`;
    }
  }
  return decoder.slice(0, loopStart) + expanded + decoder.slice(loopEnd);
}
function makeCompactDecoder(packed) {
  const parameter = packed.secondLine.match(/^,\.\.\.'([^']+)',/);
  if (!parameter) throw new Error('Unexpected Roadroller compact decoder format.');
  let decoder = `(0,eval)(Function("[M",...${JSON.stringify(parameter[1])},${packed.secondLine.slice(parameter[0].length)}`;
  if (!decoder.includes('M.charCodeAt(d++)&63') || !decoder.includes(')([],')) {
    throw new Error('Unexpected Roadroller compact decoder reader format.');
  }
  return decoder
    .replace('M.charCodeAt(d++)&63', '(M[d*3>>2]<<8|M[(d*3>>2)+1])>>(10-(d++*6&7))&63')
    .replace(')([],', ')([bytes],');
}
function deferRoadrollerExecution(decoder) {
  const immediateEval = '(0,eval)(Function(';
  if (!decoder.startsWith(immediateEval)) {
    throw new Error('Unexpected Roadroller decoder execution wrapper.');
  }
  // Keep the byte decode synchronous, but run the restored document only
  // after the parser has left this bootstrap script. This matches the native
  // DEFLATE loader's execution timing for applications that call document.open.
  return decoder.replace(immediateEval,
    '(source=>setTimeout(()=> (0,eval)(source),0))(Function(');
}
function runClosurePass(input, output, { application = false, externFiles = [] } = {}) {
  const args = [compilerCli, '--compilation_level=ADVANCED_OPTIMIZATIONS'];
  if (application) args.push('--jscomp_off=undefinedVars', '--language_in=ECMASCRIPT_NEXT');
  args.push('--env=BROWSER', '--language_out=ECMASCRIPT_2020', '--warning_level=QUIET');
  for (const extern of externFiles) args.push('--externs', extern);
  args.push('--js', input, '--js_output_file', output);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Closure Compiler failed (${path.basename(output)}):\n${result.stderr || result.stdout}`);
}
function runClosureOnce(input, output, options = {}) {
  const startedAt = performance.now();
  runClosurePass(input, output, options);
  return performance.now() - startedAt;
}
const bootstrapInput = path.join(workDir, 'input-bootstrap.js');
const appInput = path.join(workDir, 'input-app.js');
await fs.copyFile(bootstrapPath, bootstrapInput);
await fs.writeFile(appInput, appSource, 'utf8');
const externFiles = (await fs.readdir(externDir)).filter((name) => name.endsWith('.js')).sort().map((name) => path.join(externDir, name));
const optimizedAppPath = path.join(workDir, 'closure-app.js');
const classProtectionExternPath = path.join(workDir, 'class-protection.externs.js');
const nameProtectionExternPath = path.join(workDir, 'name-protection.externs.js');
const identifierName = /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u;
const classExternLines = ['/** @externs */'];
for (const name of protection.classPropertiesForExtern ?? []) {
  if (identifierName.test(name)) classExternLines.push(`Object.prototype.${name};`);
}
await fs.writeFile(classProtectionExternPath, [...new Set(classExternLines)].join('\n'), 'utf8');
const protectionExternLines = ['/** @externs */'];
for (const name of protection.protectedProperties ?? []) {
  if (identifierName.test(name)) protectionExternLines.push(`Object.prototype.${name};`);
}
for (const name of protection.protectedGlobals ?? []) protectionExternLines.push(`globalThis.${name};`);
for (const name of protection.protectedVarGlobals ?? []) protectionExternLines.push(`var ${name};`);
await fs.writeFile(nameProtectionExternPath, [...new Set(protectionExternLines)].join('\n'), 'utf8');
phaseTimesMs.applicationClosure = runClosureOnce(appInput, optimizedAppPath, {
  application: true,
  externFiles: [...externFiles, classProtectionExternPath, nameProtectionExternPath],
});
const optimizedApp = await fs.readFile(optimizedAppPath, 'utf8');
const closureExpandedApplication = Buffer.byteLength(optimizedApp) > Buffer.byteLength(appSource);
const applicationClosurePasses = 1;
function makeRoadrollerSafeSource(source) {
  const ast = parseJavaScript(source, { ecmaVersion: 'latest' });
  const edits = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'BinaryExpression' && node.operator === 'in') {
      // Roadroller's generated decoder can drop the required token boundary in
      // expressions such as `x+1 in y`, producing invalid JavaScript (`x+1in y`).
      // Parentheses preserve the expression while making that boundary unambiguous.
      edits.push({ start: node.left.start, end: node.left.end });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  let result = source;
  for (const { start, end } of edits.sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, start)}(${result.slice(start, end)})${result.slice(end)}`;
  }
  parseJavaScript(result, { ecmaVersion: 'latest' });
  return result;
}
const roadrollerSource = makeRoadrollerSafeSource(optimizedApp);
const roadrollerResult = await runRoadrollerWithTimeout(roadrollerSource);
phaseTimesMs.roadroller = roadrollerResult.elapsedMs ?? null;
const packed = roadrollerResult.packed;
let symbols = null;
let roadrollerBytes = null;
let base122Text = null;
let outputHtml = null;
let base64Html = null;
let finalLoader = null;
let bootstrap = '';
let base64Text = null;
let base64OutputPath = null;
let decoder = null;
let roadrollerDecoderMode = null;
let roadrollerDecodeMs = null;
let roadrollerDecodedBytes = null;
let marker = /["']__HTMLPACK_PAYLOAD__["']/;
if (packed) phaseStartedAt = performance.now();
if (packed) {
  const payloadStart = packed.firstLine.indexOf("M='");
  if (payloadStart < 0 || !packed.firstLine.endsWith("'\"")) throw new Error('Unexpected Roadroller decoder format.');
  const dataStart = payloadStart + 3;
  symbols = Uint8Array.from(packed.firstLine.slice(dataStart, -2), (character) => character.charCodeAt(0) & 63);
  roadrollerBytes = new Uint8Array(Math.ceil(symbols.length * 6 / 8));
  for (let i = 0; i < symbols.length; i++) {
    for (let j = 0; j < 6; j++) {
      const bit = i * 6 + j;
      roadrollerBytes[bit >> 3] |= (symbols[i] >> (5 - j) & 1) << (7 - (bit & 7));
    }
  }
  for (let i = 0; i < symbols.length; i++) {
    const offset = i * 6 >> 3;
    const word = roadrollerBytes[offset] << 8 | (roadrollerBytes[offset + 1] ?? 0);
    if ((word >> (10 - (i * 6 & 7)) & 63) !== symbols[i]) throw new Error('Six-bit stream round-trip failed.');
  }
  base122Text = Buffer.from(base122.encode(roadrollerBytes)).toString('utf8');
  const decoded = Uint8Array.from(base122.decode(base122Text));
  if (Buffer.compare(Buffer.from(roadrollerBytes), Buffer.from(decoded)) !== 0) throw new Error('Base122 round-trip failed.');

  const useFastPlusDecoder = roadrollerResult.inputBytes >= roadrollerFastPlusMinInputBytes;
  decoder = useFastPlusDecoder
    ? makeFastPlusDecoder(packed, roadrollerResult.contexts)
    : makeCompactDecoder(packed);
  roadrollerDecoderMode = useFastPlusDecoder
    ? 'small-fast++-unrolled-contexts'
    : 'small-compact-context-loop';
  const roadrollerExecution = deferRoadrollerExecution(decoder);
  const loaderSource = (await fs.readFile(bootstrapInput, 'utf8')).replace('__ROADROLLER_EXECUTE__', roadrollerExecution);
  await fs.writeFile(bootstrapInput, loaderSource, 'utf8');
  const loaderOutput = path.join(workDir, 'closure-bootstrap.js');
  phaseTimesMs.base122LoaderClosure = runClosureOnce(bootstrapInput, loaderOutput);
  bootstrap = await fs.readFile(loaderOutput, 'utf8');
  if (!marker.test(bootstrap)) throw new Error('Payload marker was lost during loader optimization.');
  finalLoader = bootstrap.replace(marker, () => jsTemplate(base122Text)).trim();
  outputHtml = `<!doctype html><meta charset="utf-8"><script>${finalLoader}</script>`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, outputHtml, 'utf8');

  // Execute the final integrated Roadroller loader in V8 and check the restored source.
  let decodedApplication;
  const scheduledExecution = [];
  const decoderSandbox = {
    Uint8Array, TextDecoder, Math,
    setTimeout(callback) { scheduledExecution.push(callback); return 1; },
    eval(code) { decodedApplication = code; },
  };
  vm.createContext(decoderSandbox);
  const decodeStartedAt = performance.now();
  vm.runInContext(finalLoader, decoderSandbox, { timeout: roadrollerTimeoutMs });
  roadrollerDecodeMs = performance.now() - decodeStartedAt;
  if (scheduledExecution.length !== 1) throw new Error(`Roadroller loader scheduled ${scheduledExecution.length} application executions; expected one.`);
  scheduledExecution[0]();
  if (typeof decodedApplication !== 'string') throw new Error('Roadroller decoder did not return JavaScript source.');
  parseJavaScript(decodedApplication, { ecmaVersion: 'latest' });
  roadrollerDecodedBytes = Buffer.byteLength(decodedApplication, 'utf8');

  // Base64 uses the browser's native decoder and reads its binary string directly.
  base64Text = Buffer.from(roadrollerBytes).toString('base64');
  if (!Buffer.from(base64Text, 'base64').equals(Buffer.from(roadrollerBytes))) throw new Error('Base64 round-trip failed.');
  const base64Decoder = deferRoadrollerExecution(decoder.replace('(M[d*3>>2]<<8|M[(d*3>>2)+1])', '(M.charCodeAt(d*3>>2)<<8|M.charCodeAt((d*3>>2)+1))'));
  const base64Input = path.join(workDir, 'input-base64-loader.js');
  const base64LoaderOutput = path.join(workDir, 'closure-base64-loader.js');
  await fs.writeFile(base64Input, `(function(){var bytes=atob("__HTMLPACK_PAYLOAD__");${base64Decoder}})();`, 'utf8');
  phaseTimesMs.base64LoaderClosure = runClosureOnce(base64Input, base64LoaderOutput);
  const base64Bootstrap = await fs.readFile(base64LoaderOutput, 'utf8');
  if (!marker.test(base64Bootstrap)) throw new Error('Base64 payload marker was lost.');
  const base64Loader = base64Bootstrap.replace(marker, () => JSON.stringify(base64Text)).trim();
  base64Html = `<!doctype html><meta charset="utf-8"><script>${base64Loader}</script>`;
  base64OutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.base64.html') : outputPath + '.base64.html';
  await fs.writeFile(base64OutputPath, base64Html, 'utf8');
} else {
  console.warn(`Roadroller outputs skipped: ${roadrollerResult.reason}`);
  const staleBase64Path = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.base64.html') : outputPath + '.base64.html';
  await fs.rm(outputPath, { force: true });
  await fs.rm(staleBase64Path, { force: true });
}
phaseTimesMs.roadrollerOutputPackaging = packed ? performance.now() - phaseStartedAt : null;

// Direct-source RegPack branch: syntax-aware whitespace minification only, with no Closure pass or renaming.
phaseStartedAt = performance.now();
const directMinified = await minifyJavaScript(directAppSource, {
  compress: false,
  mangle: false,
  format: { comments: false },
});
if (!directMinified.code) throw new Error('Terser did not return direct RegPack source.');
const directRegpackOutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.regpack.direct.html') : outputPath + '.regpack.direct.html';
await fs.rm(directRegpackOutputPath, { force: true });
const directRegpackResult = await runRegPackWithTimeout(directMinified.code, 'regpack-direct');
const directRegpackCode = directRegpackResult.code;
let directRegpackHtml = null;
let directRegpackBytes = null;
if (directRegpackCode !== null) {
  parseJavaScript(directRegpackCode, { ecmaVersion: 'latest' });
  const safeDirectRegpackCode = directRegpackCode.replace(/<\/script/gi, '<\\/script');
  directRegpackHtml = `<!doctype html><meta charset="utf-8"><script>${safeDirectRegpackCode}</script>`;
  const directRegpackScripts = [];
  function collectDirectScripts(node) {
    if (node.tagName === 'script') directRegpackScripts.push(node.childNodes.map((child) => child.value ?? '').join(''));
    for (const child of node.childNodes ?? []) collectDirectScripts(child);
  }
  collectDirectScripts(parse(directRegpackHtml));
  if (directRegpackScripts.length !== 1 || directRegpackScripts[0] !== safeDirectRegpackCode) {
    throw new Error('Direct RegPack code is not preserved by HTML script parsing.');
  }
  await fs.writeFile(directRegpackOutputPath, directRegpackHtml, 'utf8');
  directRegpackBytes = Buffer.byteLength(directRegpackCode);
} else {
  console.warn(`Direct-source RegPack output failed: ${directRegpackResult.reason}`);
}
phaseTimesMs.regpackBranches = performance.now() - phaseStartedAt;

// Independent branch: native browser DEFLATE, with no RegPack/Roadroller decoder.
phaseStartedAt = performance.now();
const deflateBytes = deflateRawSync(Buffer.from(optimizedApp, 'utf8'), { level: 9 });
if (inflateRawSync(deflateBytes).toString('utf8') !== optimizedApp) throw new Error('Raw DEFLATE round-trip failed.');
const deflateBase64 = deflateBytes.toString('base64');
const deflateLoader = `new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(deflateBase64)}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text().then(eval)`;
let deflateHtml = `<!doctype html><meta charset="utf-8"><script>${deflateLoader}</script>`;
const deflateOutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.deflate.base64.html') : outputPath + '.deflate.base64.html';
await fs.writeFile(deflateOutputPath, deflateHtml, 'utf8');
phaseTimesMs.optimizedDeflate = performance.now() - phaseStartedAt;

// Independent branch: raw LZMA1 payload with only the supplied compact data decoder.
phaseStartedAt = performance.now();
const lzmaInput = Buffer.from(optimizedApp, 'utf8');
const lzmaContainer = Buffer.from(compressLzma(new Uint8Array(lzmaInput), 9));
phaseTimesMs.lzmaCompression = performance.now() - phaseStartedAt;
phaseStartedAt = performance.now();
if (lzmaContainer.length <= 13) throw new Error('LZMA encoder returned a truncated .lzma stream.');
const lzmaProperties = lzmaContainer.subarray(0, 5);
const lzmaDeclaredSize = lzmaContainer.readBigUInt64LE(5);
if (lzmaDeclaredSize !== BigInt(lzmaInput.length)) throw new Error('LZMA stream has an unexpected uncompressed size.');
const lzmaRawBytes = lzmaContainer.subarray(13);
const lzmaNativeRoundTrip = Buffer.from(decompressLzma(lzmaContainer));
if (!lzmaNativeRoundTrip.equals(lzmaInput)) throw new Error('LZMA package round-trip failed.');
const lzmaVm = { MAX_BLOCK: 0x7fffffff, archiveCheck(condition, reason) { if (!condition) throw new Error(`LZMA ${reason ?? 'decode'} failed.`); } };
vm.createContext(lzmaVm);
const lzmaDecoderSource = await fs.readFile(lzmaDecoderPath, 'utf8');
vm.runInContext(`${lzmaDecoderSource}\nthis.decodeLzma=decodeLzma;`, lzmaVm);
const lzmaDecoded = lzmaVm.decodeLzma(new Uint8Array(lzmaRawBytes), new Uint8Array(lzmaProperties), lzmaInput.length);
if (!Buffer.from(lzmaDecoded).equals(lzmaInput)) throw new Error('Supplied LZMA data decoder round-trip failed.');
const lzmaBase122 = Buffer.from(base122.encode(lzmaRawBytes)).toString('utf8');
if (Buffer.compare(Buffer.from(base122.decode(lzmaBase122)), lzmaRawBytes) !== 0) throw new Error('LZMA Base122 payload round-trip failed.');
const lzmaRuntime = await fs.readFile(bootstrapPath, 'utf8');
const lzmaExecute = `var restored=decodeLzma(bytes,new Uint8Array(${JSON.stringify([...lzmaProperties])}),${lzmaInput.length});(0,eval)(new TextDecoder().decode(restored));`;
const lzmaLoaderSource = `var MAX_BLOCK=2147483647;function archiveCheck(ok,reason){if(!ok)throw Error("LZMA "+(reason||"decode"));}\n${lzmaDecoderSource}\n${lzmaRuntime.replace('__ROADROLLER_EXECUTE__', lzmaExecute)}`;
const lzmaInputPath = path.join(workDir, 'input-lzma-loader.js');
const lzmaClosurePath = path.join(workDir, 'closure-lzma-loader.js');
await fs.writeFile(lzmaInputPath, lzmaLoaderSource, 'utf8');
phaseTimesMs.lzmaBase122LoaderClosure = runClosureOnce(lzmaInputPath, lzmaClosurePath);
let lzmaLoader = await fs.readFile(lzmaClosurePath, 'utf8');
if (!marker.test(lzmaLoader)) throw new Error('LZMA payload marker was lost during loader optimization.');
lzmaLoader = lzmaLoader.replace(marker, () => jsTemplate(lzmaBase122)).trim();
let lzmaHtml = `<!doctype html><meta charset="utf-8"><script>${lzmaLoader}</script>`;
const lzmaOutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.lzma.base122.html') : outputPath + '.lzma.base122.html';
await fs.writeFile(lzmaOutputPath, lzmaHtml, 'utf8');
phaseTimesMs.lzmaPayloadPackaging = performance.now() - phaseStartedAt;

let applicationRuntimeFallback = null;
let originalHtmlLzmaMetrics = null;
if (hasOpaqueDynamicEval && !hasStaticApplicationMarkup && closureExpandedApplication) {
  outputHtml = html;
  await fs.writeFile(outputPath, inputBytes);
  applicationRuntimeFallback = 'Copied the exact input HTML: opaque eval-based application, no static app markup, and Closure output grew.';
  console.warn(`Main output uses the exact input HTML because Closure expanded an opaque eval-based script (${Buffer.byteLength(appSource)} -> ${Buffer.byteLength(optimizedApp)} bytes).`);

  // The same opaque-eval and parser-position problem applies to the alternate
  // wrappers. Encode the original complete HTML for each output instead of
  // embedding the reassembled/Closure-compiled application source.
  const originalBase64LoaderInput = path.join(workDir, 'input-original-base64-html-loader.js');
  const originalBase64LoaderOutput = path.join(workDir, 'closure-original-base64-html-loader.js');
  const originalHtmlBase64 = inputBytes.toString('base64');
  await fs.writeFile(originalBase64LoaderInput,
    'var b=atob("__HTMLPACK_PAYLOAD__"),u=Uint8Array.from(b,c=>c.charCodeAt(0));document.open();document.write(new TextDecoder().decode(u));document.close();',
    'utf8');
  phaseTimesMs.originalHtmlBase64LoaderClosure = runClosureOnce(originalBase64LoaderInput, originalBase64LoaderOutput);
  let originalBase64Loader = await fs.readFile(originalBase64LoaderOutput, 'utf8');
  if (!marker.test(originalBase64Loader)) throw new Error('Original HTML Base64 payload marker was lost during loader optimization.');
  originalBase64Loader = originalBase64Loader.replace(marker, () => JSON.stringify(originalHtmlBase64)).trim();
  base64Html = `<!doctype html><meta charset="utf-8"><script>${originalBase64Loader}</script>`;
  base64OutputPath = /\.html?$/i.test(outputPath) ? outputPath.replace(/\.html?$/i, '.base64.html') : outputPath + '.base64.html';
  await fs.writeFile(base64OutputPath, base64Html, 'utf8');

  await fs.copyFile(originalOutputPath, deflateOutputPath);
  deflateHtml = originalPacked.html;

  const originalLzmaContainer = Buffer.from(compressLzma(new Uint8Array(inputBytes), 9));
  if (originalLzmaContainer.length <= 13) throw new Error('Original HTML LZMA encoder returned a truncated stream.');
  const originalLzmaProperties = originalLzmaContainer.subarray(0, 5);
  const originalLzmaSize = originalLzmaContainer.readBigUInt64LE(5);
  if (originalLzmaSize !== BigInt(inputBytes.length)) throw new Error('Original HTML LZMA stream has an unexpected uncompressed size.');
  const originalLzmaBytes = originalLzmaContainer.subarray(13);
  const originalLzmaBase122 = Buffer.from(base122.encode(originalLzmaBytes)).toString('utf8');
  if (!Buffer.from(base122.decode(originalLzmaBase122)).equals(originalLzmaBytes)) throw new Error('Original HTML LZMA Base122 round-trip failed.');
  originalHtmlLzmaMetrics = {
    inputBytes: inputBytes.length,
    compressedBytes: originalLzmaBytes.length,
    base122Bytes: Buffer.byteLength(originalLzmaBase122),
    payloadLiteralBytes: Buffer.byteLength(jsTemplate(originalLzmaBase122)),
  };
  const originalLzmaExecute = `var restored=decodeLzma(bytes,new Uint8Array(${JSON.stringify([...originalLzmaProperties])}),${inputBytes.length});document.open();document.write(new TextDecoder().decode(restored));document.close();`;
  const originalLzmaLoaderSource = `var MAX_BLOCK=2147483647;function archiveCheck(ok,reason){if(!ok)throw Error("LZMA "+(reason||"decode"));}\n${lzmaDecoderSource}\n${lzmaRuntime.replace('__ROADROLLER_EXECUTE__', originalLzmaExecute)}`;
  const originalLzmaLoaderInput = path.join(workDir, 'input-original-lzma-html-loader.js');
  const originalLzmaLoaderOutput = path.join(workDir, 'closure-original-lzma-html-loader.js');
  await fs.writeFile(originalLzmaLoaderInput, originalLzmaLoaderSource, 'utf8');
  phaseTimesMs.originalHtmlLzmaLoaderClosure = runClosureOnce(originalLzmaLoaderInput, originalLzmaLoaderOutput);
  let originalLzmaLoader = await fs.readFile(originalLzmaLoaderOutput, 'utf8');
  if (!marker.test(originalLzmaLoader)) throw new Error('Original HTML LZMA payload marker was lost during loader optimization.');
  originalLzmaLoader = originalLzmaLoader.replace(marker, () => jsTemplate(originalLzmaBase122)).trim();
  const originalLzmaHtml = `<!doctype html><meta charset="utf-8"><script>${originalLzmaLoader}</script>`;
  await fs.writeFile(lzmaOutputPath, originalLzmaHtml, 'utf8');
  lzmaHtml = originalLzmaHtml;

  let restoredOriginalHtml = '';
  const originalLzmaSandbox = {
    Uint8Array, DataView, TextDecoder, Math,
    document: { open() {}, write(value) { restoredOriginalHtml += value; }, close() {} },
  };
  vm.createContext(originalLzmaSandbox);
  vm.runInContext(originalLzmaLoader, originalLzmaSandbox, { timeout: roadrollerTimeoutMs });
  if (restoredOriginalHtml !== html) throw new Error('Original HTML LZMA loader did not restore the input HTML exactly.');

  let restoredBase64Html = '';
  const originalBase64Sandbox = {
    atob, Uint8Array, TextDecoder,
    document: { open() {}, write(value) { restoredBase64Html += value; }, close() {} },
  };
  vm.createContext(originalBase64Sandbox);
  vm.runInContext(originalBase64Loader, originalBase64Sandbox, { timeout: roadrollerTimeoutMs });
  if (restoredBase64Html !== html) throw new Error('Original HTML Base64 loader did not restore the input HTML exactly.');
}

const sizes = { ...(outputHtml ? { [applicationRuntimeFallback ? 'Exact input fallback' : 'Roadroller + Base122']: Buffer.byteLength(outputHtml) } : {}), ...(base64Html ? { [applicationRuntimeFallback ? 'Original HTML + Base64' : 'Roadroller + Base64']: Buffer.byteLength(base64Html) } : {}), ...(directRegpackHtml ? { 'RegPack direct': Buffer.byteLength(directRegpackHtml) } : {}), 'DEFLATE+Base64': Buffer.byteLength(deflateHtml), 'LZMA1+Base122': Buffer.byteLength(lzmaHtml), 'Original+DEFLATE+Base64': originalPacked.htmlBytes, 'Original+DEFLATE+Base122': Buffer.byteLength(originalBase122Html) };
phaseTimesMs.totalBuildOne = performance.now() - buildStartedAt;

console.log(JSON.stringify({
  input: path.relative(root, inputPath),
  sourceCopy: path.relative(root, sourceCopyPath),
  output: outputHtml ? path.relative(root, outputPath) : null,
  applicationRuntimeFallback,
  roadrollerContexts: roadrollerResult.contexts,
  roadrollerDecoderMode: packed ? roadrollerDecoderMode : null,
  roadrollerDecodeMs: roadrollerDecodeMs === null ? null : +roadrollerDecodeMs.toFixed(2),
  roadrollerDecodedBytes,
  outputSkipped: outputHtml ? null : roadrollerResult.reason,
  base64Output: base64Html ? path.relative(root, base64OutputPath) : null,
  base64OutputSkipped: base64Html ? null : roadrollerResult.reason,
  directRegpackOutput: directRegpackHtml ? path.relative(root, directRegpackOutputPath) : null,
  directRegpackSkipped: directRegpackHtml ? null : directRegpackResult.reason,
  deflateBase64Output: path.relative(root, deflateOutputPath),
  lzmaBase122Output: path.relative(root, lzmaOutputPath),
  lzmaInputBytes: originalHtmlLzmaMetrics?.inputBytes ?? lzmaInput.length,
  lzmaCompressedBytes: originalHtmlLzmaMetrics?.compressedBytes ?? lzmaRawBytes.length,
  lzmaBase122Bytes: originalHtmlLzmaMetrics?.base122Bytes ?? Buffer.byteLength(lzmaBase122),
  lzmaPayloadLiteralBytes: originalHtmlLzmaMetrics?.payloadLiteralBytes ?? Buffer.byteLength(jsTemplate(lzmaBase122)),
  lzmaHtmlBytes: Buffer.byteLength(lzmaHtml),
  lzmaLevel: 9,
  originalDeflateBase64Output: path.relative(root, originalOutputPath),
  originalDeflateBase122Output: path.relative(root, originalBase122OutputPath),
  originalDeflateBytes: originalDeflateBytes.length,
  originalDeflateBase122Bytes: Buffer.byteLength(originalBase122),
  originalDeflateBase122HtmlBytes: Buffer.byteLength(originalBase122Html),
  inlineScriptsCombined: activeScripts.length,
  cssMinifier: 'Lightning CSS',
  cssTargets: ['chrome 120', 'safari 17', 'firefox 121'],
  cssInputBytes,
  cssOutputBytes,
  cssSavedBytes: cssInputBytes - cssOutputBytes,
  nameProtection: 'enabled',
  protectedGlobals: protection.protectedGlobals ?? [],
  protectedVarGlobals: protection.protectedVarGlobals ?? [],
  applicationOptimizer: 'Closure ADVANCED_OPTIMIZATIONS (1 pass)',
  closureCompilationPasses: 3 + (packed ? 2 : 0),
  roadrollerPacks: packed ? 1 : 0,
  roadrollerSkipped: packed ? null : roadrollerResult.reason,
  roadrollerTimeoutMs,
  roadrollerO1MaxInputBytes,
  roadrollerTwelveContextMaxInputBytes,
  roadrollerFastPlusMinInputBytes,
  roadrollerMaxInputBytes,
  roadrollerInputBytes: roadrollerResult.inputBytes,
  applicationOptimizerInputBytes: Buffer.byteLength(appSource),
  applicationOptimizerOutputBytes: Buffer.byteLength(optimizedApp),
  phaseTimesMs: Object.fromEntries(Object.entries(phaseTimesMs).map(([name, elapsed]) => [name, elapsed === null ? null : +elapsed.toFixed(2)])),
  closure: 'ADVANCED_OPTIMIZATIONS (application and loaders, one pass each)',
  roadrollerOptimize: roadrollerResult.mode === 'o1' ? 'O1' : roadrollerResult.mode === 'skipped' ? 'skipped' : 'fixed parameters (O1 skipped)',
  sourceHtmlBytes: Buffer.byteLength(html),
  staticHtmlPrintedBytes: Buffer.byteLength(staticHtml),
  sourceJavaScriptBytes: Buffer.byteLength(appStatements),
  closureBytes: Buffer.byteLength(bootstrap) + Buffer.byteLength(optimizedApp),
  optimizedApplicationBytes: Buffer.byteLength(optimizedApp),
  roadrollerBytes: roadrollerBytes?.byteLength ?? null,
  roadrollerSixBitSymbols: symbols?.length ?? null,
  loaderBytesExcludingPayload: finalLoader ? Buffer.byteLength(finalLoader) - Buffer.byteLength(jsTemplate(base122Text)) : null,
  base122Bytes: base122Text === null ? null : Buffer.byteLength(base122Text),
  outputHtmlBytes: outputHtml ? Buffer.byteLength(outputHtml) : null,
  base64HtmlBytes: base64Html ? Buffer.byteLength(base64Html) : null,
  directRegpackSourceBytes: Buffer.byteLength(directAppSource),
  directRegpackInputBytes: Buffer.byteLength(directMinified.code),
  directRegpackCodeBytes: directRegpackBytes,
  directRegpackHtmlBytes: directRegpackHtml ? Buffer.byteLength(directRegpackHtml) : null,
  directRegpackHtmlParsing: directRegpackHtml ? 'passed' : null,
  deflateRawCompressedBytes: applicationRuntimeFallback ? originalPacked.compressedBytes : deflateBytes.length,
  originalDeflateCompressedBytes: originalPacked.compressedBytes,
  originalDeflateHtmlBytes: originalPacked.htmlBytes,
  deflateHtmlBytes: Buffer.byteLength(deflateHtml),
  deflateLoaderBytesExcludingPayload: Buffer.byteLength(deflateLoader) - deflateBase64.length,
  lzmaLoaderBytesExcludingPayload: Buffer.byteLength(lzmaLoader) - Buffer.byteLength(jsTemplate(lzmaBase122)),
  smallestVersion: Object.keys(sizes).sort((a, b) => sizes[a] - sizes[b])[0],
  smallerEncoding: base64Html && outputHtml ? (Buffer.byteLength(base64Html) < Buffer.byteLength(outputHtml) ? 'Base64' : 'Base122') : null,
  base122RoundTrip: packed ? 'passed' : null,
  base64RoundTrip: base64Text ? 'passed' : null,
  deflateRoundTrip: 'passed',
  lzmaPackageRoundTrip: 'passed',
  lzmaReferenceDecoderRoundTrip: 'passed',
  lzmaBase122RoundTrip: 'passed',
  originalHtmlBytesRoundTrip: 'passed',
}, null, 2));
