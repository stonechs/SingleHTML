import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  return {
    nodeName: 'style', tagName: 'style', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [{ nodeName: '#text', value: css }], parentNode: parent,
  };
}

function replaceNode(oldNode, newNode) {
  const siblings = oldNode.parentNode.childNodes;
  const index = siblings.indexOf(oldNode);
  if (index < 0) throw new Error('Could not replace an HTML node while bundling resources.');
  newNode.parentNode = oldNode.parentNode;
  siblings.splice(index, 1, newNode);
}

async function inlineDocument(html, owner, iframeStack = new Set()) {
  const document = parse(html);
  async function walk(node) {
    for (const child of [...(node.childNodes ?? [])]) {
      if (child.tagName === 'script') {
        const attrs = attrsOf(child);
        if ('src' in attrs) {
          if ('async' in attrs) throw new Error(`External async scripts cannot be safely combined: ${attrs.src}`);
          const filePath = resolveLocal(attrs.src, owner);
          if (!filePath) throw new Error(`Invalid empty external script source in ${path.relative(projectDir, owner)}`);
          const source = await fs.readFile(filePath, 'utf8');
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
            const nested = await inlineDocument(await fs.readFile(filePath, 'utf8'), filePath, new Set(iframeStack).add(filePath));
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
  let bundled = await inlineDocument(html, entryPath, new Set([entryPath]));
  const imageFiles = (await collectFiles(projectDir)).filter(({ absolutePath }) => /^image\//.test(mimeTypes[path.extname(absolutePath).toLowerCase()] ?? ''));
  if (imageFiles.length) {
    const imageMap = Object.fromEntries(await Promise.all(imageFiles.map(async ({ absolutePath, relativePath }) => [relativePath, await asDataUri(absolutePath)])));
    const imageBootstrap = `(function(m){var p=HTMLImageElement.prototype,d=Object.getOwnPropertyDescriptor(p,"src"),s=d.set,g=d.get;function k(v){v=String(v).split(/[?#]/,1)[0];try{v=decodeURIComponent(v)}catch(e){}return v.replaceAll("\\\\","/").replace(/^\\.\\//,"").replace(/^\\/+/,"")}Object.defineProperty(p,"src",{configurable:d.configurable,enumerable:d.enumerable,get:function(){return g.call(this)},set:function(v){var x=String(v),n=k(x),b=n.slice(n.lastIndexOf("/")+1);s.call(this,m[x]||m[n]||m[b]||x)}})} )(${JSON.stringify(imageMap)});`;
    const document = parse(bundled);
    let parent = document.childNodes.find((node) => node.tagName === 'html');
    parent = parent?.childNodes.find((node) => node.tagName === 'body') ?? parent?.childNodes.find((node) => node.tagName === 'head') ?? document;
    const script = {
      nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml',
      childNodes: [{ nodeName: '#text', value: imageBootstrap }], parentNode: parent,
    };
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
