import { deflateRawSync, inflateRawSync } from 'node:zlib';

// Compress the source file bytes verbatim: no parsing or JavaScript rewriting.
export function packOriginalHtml(source) {
  const compressed = deflateRawSync(source, { level: 9, memLevel: 9 });
  if (!inflateRawSync(compressed).equals(source)) throw new Error('Original HTML byte round-trip failed.');
  const base64 = compressed.toString('base64');
  const loader = `new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text().then(s=>{document.open();document.write(s);document.close()})`;
  const html = `<!doctype html><meta charset="utf-8"><script>${loader}</script>`;
  return { html, sourceBytes: source.length, compressedBytes: compressed.length, base64Bytes: base64.length, htmlBytes: Buffer.byteLength(html) };
}
