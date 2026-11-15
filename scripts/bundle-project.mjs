import fs from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse, serialize } from 'parse5';

const projectDir = path.resolve(process.argv[2]);
const entryPath = path.resolve(process.argv[3]);
const outputPath = path.resolve(process.argv[4]);
const mimeTypes = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.css': 'text/css', '.csv': 'text/csv',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.txt': 'text/plain',
  '.wasm': 'application/wasm', '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml',
};

function failExternal(reference, owner) {
  throw new Error(`Cannot make the project fully offline: external resource "${reference}" in ${path.relative(projectDir, owner)}`);
}

function resolveLocal(reference, owner) {
  const trimmed = reference.trim();
  if (!trimmed || /^(?:data:|blob:|#)/i.test(trimmed)) return null;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(trimmed)) failExternal(trimmed, owner);
  const pathPart = decodeURIComponent(trimmed.split(/[?#]/, 1)[0]).replaceAll('\\', '/');
  const resolved = path.resolve(path.dirname(owner), pathPart);
  const relative = path.relative(projectDir, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Resource escapes project directory: "${reference}" in ${path.relative(projectDir, owner)}`);
  }
  return resolved;
}

async function asDataUri(filePath) {
  const bytes = await fs.readFile(filePath);
  const mime = mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

async function readTextResource(filePath) {
  const bytes = await fs.readFile(filePath);
  const content = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return content.toString('utf8');
}

async function readRuntimeResource(filePath) {
  const bytes = await fs.readFile(filePath);
  const content = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return isUtf8(content)
    ? content.toString('utf8')
    : { __htmlpackBinary: content.toString('base64') };
}

async function collectFiles(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath, relativePath));
    else if (entry.isFile()) files.push({ absolutePath, relativePath: relativePath.replaceAll('\\', '/') });
  }
  return files;
}

async function replaceAsync(value, expression, replacer) {
  const matches = [...value.matchAll(expression)];
  const replacements = await Promise.all(matches.map((match) => replacer(...match)));
  let index = 0;
  return value.replace(expression, () => replacements[index++]);
}

async function inlineCss(css, owner, importStack = new Set()) {
  css = await replaceAsync(css, /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^\s);]+))\s*\)?\s*([^;]*);/gi,
    async (whole, quote, quotedPath, barePath, media = '') => {
      const reference = quotedPath ?? barePath;
      const filePath = resolveLocal(reference, owner);
      if (!filePath) return whole;
      if (importStack.has(filePath)) throw new Error(`Circular CSS @import: ${path.relative(projectDir, filePath)}`);
      const nextStack = new Set(importStack).add(filePath);
      const imported = await fs.readFile(filePath, 'utf8');
      const content = await inlineCss(imported, filePath, nextStack);
      return media.trim() ? `@media ${media.trim()}{${content}}` : content;
    });
  return replaceAsync(css, /url\(\s*(["']?)(.*?)\1\s*\)/gi, async (whole, _quote, reference) => {
    const filePath = resolveLocal(reference, owner);
    return filePath ? `url("${await asDataUri(filePath)}")` : whole;
  });
}

function attrsOf(node) {
  return Object.fromEntries((node.attrs ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
}

function setAttr(node, name, value) {
  const existing = node.attrs.find((attr) => attr.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.value = value;
  else node.attrs.push({ name, value });
}

function removeAttr(node, name) {
  node.attrs = node.attrs.filter((attr) => attr.name.toLowerCase() !== name.toLowerCase());
}

function setText(node, value) {
  node.childNodes = [{ nodeName: '#text', value, parentNode: node }];
}

function makeStyleNode(css, parent) {
  const node = {
    nodeName: 'style', tagName: 'style', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [], parentNode: parent,
  };
  node.childNodes.push({ nodeName: '#text', value: css, parentNode: node });
  return node;
}

function replaceNode(oldNode, newNode) {
  const siblings = oldNode.parentNode.childNodes;
  const index = siblings.indexOf(oldNode);
  if (index < 0) throw new Error('Could not replace an HTML node while bundling resources.');
  newNode.parentNode = oldNode.parentNode;
  siblings.splice(index, 1, newNode);
}

async function inlineDocument(html, owner, iframeStack = new Set(), navigationPages = new Map()) {
  const document = parse(html);
  let scriptCount = 0;
  function countScripts(node) {
    if (node.tagName === 'script') scriptCount++;
    for (const child of node.childNodes ?? []) countScripts(child);
    if (node.content) countScripts(node.content);
  }
  countScripts(document);
  async function walk(node) {
    for (const child of [...(node.childNodes ?? [])]) {
      if (child.tagName === 'script') {
        const attrs = attrsOf(child);
        if ('src' in attrs) {
          if ('async' in attrs) {
            // The packer combines executable scripts into one optimized program.
            // Preserve this only for a document with a single script: its markup
            // has already been emitted before the combined program runs, so the
            // asynchronous fetch timing is unnecessary, while script ordering
            // relative to other application scripts would not be preserved.
            if (scriptCount !== 1) throw new Error(`External async script cannot be combined with other scripts: ${attrs.src}`);
            removeAttr(child, 'async');
          }
          const filePath = resolveLocal(attrs.src, owner);
          if (!filePath) throw new Error(`Invalid empty external script source in ${path.relative(projectDir, owner)}`);
          let source = await readTextResource(filePath);
          source = await replaceAsync(source, /\bnew\s+Audio\(\s*(["'])([^"'\\]+)\1\s*\)/g, async (whole, _quote, reference) => {
            if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return whole;
            const assetPath = resolveLocal(reference, filePath);
            return assetPath ? `new Audio(${JSON.stringify(await asDataUri(assetPath))})` : whole;
          });
          removeAttr(child, 'src');
          removeAttr(child, 'integrity');
          removeAttr(child, 'crossorigin');
          removeAttr(child, 'referrerpolicy');
          setText(child, source.replace(/<\/script/gi, '<\\/script'));
        }
      } else if (child.tagName === 'link') {
        const attrs = attrsOf(child);
        const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
        if (attrs.href && rel.includes('stylesheet')) {
          const filePath = resolveLocal(attrs.href, owner);
          if (!filePath) throw new Error(`Invalid empty stylesheet link in ${path.relative(projectDir, owner)}`);
          const css = await inlineCss(await fs.readFile(filePath, 'utf8'), filePath);
          const styleNode = makeStyleNode(css, child.parentNode);
          for (const name of ['media', 'title', 'nonce', 'disabled']) {
            if (name in attrs) setAttr(styleNode, name, attrs[name]);
          }
          replaceNode(child, styleNode);
          continue;
        }
        if (attrs.href && ['icon', 'manifest', 'preload', 'modulepreload'].some((value) => rel.includes(value))) {
          const filePath = resolveLocal(attrs.href, owner);
          if (filePath) setAttr(child, 'href', await asDataUri(filePath));
        }
      } else if (child.tagName === 'a') {
        const attrs = attrsOf(child);
        const href = attrs.href ?? '';
        if (!attrs.target && !('download' in attrs) && /\.html?(?:[?#]|$)/i.test(href) && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) {
          const filePath = resolveLocal(href, owner);
          if (filePath && !iframeStack.has(filePath)) {
            const key = path.relative(projectDir, filePath).replaceAll('\\', '/');
            let nested = navigationPages.get(key);
            if (nested === undefined) {
              nested = await inlineDocument(await fs.readFile(filePath, 'utf8'), filePath, new Set(iframeStack).add(filePath), navigationPages);
              navigationPages.set(key, nested);
            }
            setAttr(child, 'href', '#');
            setAttr(child, 'data-htmlpack-page', key);
          }
        }
      } else if (child.tagName === 'style') {
        const css = (child.childNodes ?? []).map((part) => part.value ?? '').join('');
        setText(child, await inlineCss(css, owner));
      }

      const attrs = attrsOf(child);
      if (attrs.style) setAttr(child, 'style', await inlineCss(attrs.style, owner));
      for (const attribute of ['src', 'poster', 'data']) {
        if (!attrs[attribute] || (attribute === 'data' && child.tagName !== 'object')) continue;
        if (child.tagName === 'script' || child.tagName === 'link') continue;
        if (attribute === 'src' && child.tagName === 'iframe') {
          const filePath = resolveLocal(attrs.src, owner);
          if (filePath) {
            if (iframeStack.has(filePath)) throw new Error(`Circular iframe reference: ${path.relative(projectDir, filePath)}`);
            const nested = await inlineDocument(await fs.readFile(filePath, 'utf8'), filePath, new Set(iframeStack).add(filePath), navigationPages);
            setAttr(child, 'srcdoc', nested);
            removeAttr(child, 'src');
          }
          continue;
        }
        const supported = attribute !== 'data' || child.tagName === 'object';
        if (supported) {
          const filePath = resolveLocal(attrs[attribute], owner);
          if (filePath) setAttr(child, attribute, await asDataUri(filePath));
        }
      }
      if (attrs.srcset && ['img', 'source'].includes(child.tagName)) {
        const candidates = [];
        let rest = attrs.srcset.trim();
        while (rest) {
          rest = rest.replace(/^\s*,?\s*/, '');
          if (!rest) break;
          const isData = /^data:/i.test(rest);
          const urlMatch = rest.match(isData ? /^(\S+)/ : /^([^\s,]+)/);
          if (!urlMatch) break;
          const reference = urlMatch[1];
          rest = rest.slice(reference.length);
          const descriptorMatch = rest.match(/^\s*([^,]*?)(?:\s*,|$)/);
          const descriptor = descriptorMatch?.[1]?.trim() ?? '';
          rest = rest.slice(descriptorMatch?.[0].length ?? rest.length);
          const filePath = resolveLocal(reference, owner);
          candidates.push(`${filePath ? await asDataUri(filePath) : reference}${descriptor ? ` ${descriptor}` : ''}`);
        }
        setAttr(child, 'srcset', candidates.join(', '));
      }
      await walk(child);
    }
    if (node.content) await walk(node.content);
  }
  await walk(document);
  return serialize(document);
}

try {
  const relativeEntry = path.relative(projectDir, entryPath);
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) throw new Error('Entry HTML must be inside the project directory.');
  const html = await fs.readFile(entryPath, 'utf8');
  const navigationPages = new Map();
  let bundled = await inlineDocument(html, entryPath, new Set([entryPath]), navigationPages);
  if (navigationPages.size) {
    const encodedPages = Object.fromEntries([...navigationPages].map(([name, page]) => [name, Buffer.from(page, 'utf8').toString('base64')]));
    const navigationBootstrap = `(function(p){document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[data-htmlpack-page]");if(!a)return;e.preventDefault();var s=p[a.getAttribute("data-htmlpack-page")];if(s===void 0)return;document.open();document.write(new TextDecoder().decode(Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})));document.close()})})(${JSON.stringify(encodedPages).replace(/<\//g, '<\\/')});`;
    const document = parse(bundled);
    let parent = document.childNodes.find((node) => node.tagName === 'html');
    parent = parent?.childNodes.find((node) => node.tagName === 'head') ?? parent ?? document;
    const script = { nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: parent };
    script.childNodes.push({ nodeName: '#text', value: navigationBootstrap, parentNode: script });
    parent.childNodes.unshift(script);
    bundled = serialize(document);
    console.log(`Embedded ${navigationPages.size} linked HTML page(s) for in-file navigation.`);
  }
  // Some small game collections discover their pages at runtime (for example,
  // XMLHttpRequest("2.htm") followed by iframe.src = "2.htm"). Static DOM
  // traversal cannot see those references, so embed the complete project file
  // set and route those runtime requests to the embedded copies.
  const projectFiles = await collectFiles(projectDir);
  const runtimeFiles = Object.fromEntries(await Promise.all(projectFiles
    .filter(({ absolutePath }) => absolutePath !== entryPath)
    .map(async ({ absolutePath, relativePath }) => [relativePath, await readRuntimeResource(absolutePath)])));
  if (Object.keys(runtimeFiles).length) {
    const runtimeBootstrap = `(function(m){function k(u){u=String(u).split(/[?#]/,1)[0];try{u=decodeURIComponent(u)}catch(e){}u=u.replaceAll("\\\\","/");while(u.startsWith("./"))u=u.slice(2);while(u.startsWith("/"))u=u.slice(1);return u}function g(u){var n=k(u);return Object.prototype.hasOwnProperty.call(m,n)?m[n]:m[n.slice(n.lastIndexOf("/")+1)]}var X=XMLHttpRequest,p=X.prototype,o=p.open,s=p.send;p.open=function(a,u,b){var v=g(u);if(v===void 0){delete this.__htmlpack;return o.apply(this,arguments)}this.__htmlpack=v;this.__htmlpackAsync=b!==false;this.readyState=1};p.send=function(){if(!Object.prototype.hasOwnProperty.call(this,"__htmlpack"))return s.apply(this,arguments);var x=this;function f(){for(var a in {responseText:x.__htmlpack,response:x.__htmlpack,status:200,statusText:"OK",readyState:4})try{Object.defineProperty(x,a,{configurable:true,value:a==="readyState"?4:a==="status"?200:a==="statusText"?"OK":x.__htmlpack})}catch(e){}if(x.onreadystatechange)x.onreadystatechange();if(x.onload)x.onload()}if(this.__htmlpackAsync)setTimeout(f,0);else f()};var ep=Element.prototype,id=Object.getOwnPropertyDescriptor(ep,"innerHTML");if(id&&id.set)Object.defineProperty(ep,"innerHTML",{configurable:id.configurable,enumerable:id.enumerable,get:id.get,set:function(v){if(typeof v==="string")v=v.replace(/(<iframe\\b[^>]*?)\\s+src=(["']?)([^"' >]+)\\2/gi,function(a,b,q,u){var h=g(u);return h===void 0?a:b+' srcdoc="'+h.replace(/&/g,"&amp;").replace(/"/g,"&quot;")+'"'});id.set.call(this,v)}})})(` + JSON.stringify(runtimeFiles).replace(/<\/script/gi, '<\\/script') + `);`;
    const fetchBootstrap = `(function(m){function k(u){u=String(u).split(/[?#]/,1)[0];try{u=decodeURIComponent(u)}catch(e){}u=u.replaceAll("\\\\","/");while(u.startsWith("./"))u=u.slice(2);while(u.startsWith("/"))u=u.slice(1);return u}function g(u){var n=k(u);return Object.prototype.hasOwnProperty.call(m,n)?m[n]:m[n.slice(n.lastIndexOf("/")+1)]}var f=window.fetch;window.fetch=function(u,o){var v=g(u&&u.url||u);if(v===void 0||o&&o.method&&o.method.toUpperCase()!=="GET")return f.apply(this,arguments);var b=v&&v.__htmlpackBinary;return Promise.resolve(new Response(b?Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)}):v,{status:200}))}})(` + JSON.stringify(runtimeFiles).replace(/<\/script/gi, '<\\/script') + `);`;
    const document = parse(bundled);
    let parent = document.childNodes.find((node) => node.tagName === 'html');
    parent = parent?.childNodes.find((node) => node.tagName === 'head') ?? parent ?? document;
    const script = { nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: parent };
    script.childNodes.push({ nodeName: '#text', value: runtimeBootstrap, parentNode: script });
    parent.childNodes.unshift(script);
    const fetchScript = { nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: parent };
    fetchScript.childNodes.push({ nodeName: '#text', value: fetchBootstrap, parentNode: fetchScript });
    parent.childNodes.splice(1, 0, fetchScript);
    bundled = serialize(document);
    console.log(`Embedded ${Object.keys(runtimeFiles).length} runtime-accessible project file(s).`);
  }
  const imageFiles = (await collectFiles(projectDir)).filter(({ absolutePath }) => /^image\//.test(mimeTypes[path.extname(absolutePath).toLowerCase()] ?? ''));
  if (imageFiles.length) {
    const imageMap = Object.fromEntries(await Promise.all(imageFiles.map(async ({ absolutePath, relativePath }) => [relativePath, await asDataUri(absolutePath)])));
    const imageBase = path.relative(projectDir, path.dirname(entryPath)).split(path.sep).join("/");
    const imageBootstrap = `(function(m,base){function k(v){v=String(v).split(/[?#]/,1)[0];try{v=decodeURIComponent(v)}catch(e){}return v.replaceAll("\\\\","/").replace(/^\\.\\//,"").replace(/^\\/+/,"")}function u(v){return v.replace(/url\\(\\s*(["']?)(.*?)\\1\\s*\\)/gi,function(a,q,x){var n=k(x),b=n.slice(n.lastIndexOf("/")+1),d=m[x]||m[n]||m[b];return d?'url("'+d+'")':a})}var p=HTMLImageElement.prototype,d=Object.getOwnPropertyDescriptor(p,"src"),s=d.set,g=d.get,o=new WeakMap;Object.defineProperty(p,"src",{configurable:d.configurable,enumerable:d.enumerable,get:function(){return o.has(this)?o.get(this):g.call(this)},set:function(v){var x=String(v),n=k(x),b=n.slice(n.lastIndexOf("/")+1),r=m[k(base+"/"+n)]||m[x]||m[n]||m[b];if(r){o.set(this,x);s.call(this,r)}else{o.delete(this);s.call(this,x)}}});var t=Element.prototype,i=Object.getOwnPropertyDescriptor(t,"innerHTML");if(i&&i.set)Object.defineProperty(t,"innerHTML",{configurable:i.configurable,enumerable:i.enumerable,get:i.get,set:function(v){i.set.call(this,typeof v==="string"&&this.tagName==="STYLE"?u(v):v)}})} )(${JSON.stringify(imageMap)},${JSON.stringify(imageBase)});`;
    const document = parse(bundled);
    let parent = document.childNodes.find((node) => node.tagName === 'html');
    parent = parent?.childNodes.find((node) => node.tagName === 'head') ?? parent?.childNodes.find((node) => node.tagName === 'body') ?? document;
    const script = { nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: parent };
    script.childNodes.push({ nodeName: '#text', value: imageBootstrap, parentNode: script });
    parent.childNodes.unshift(script);
    bundled = serialize(document);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bundled, 'utf8');
  console.log(`Bundled ${path.relative(projectDir, entryPath)} with its local resources into ${pathToFileURL(outputPath).pathname}`);
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
