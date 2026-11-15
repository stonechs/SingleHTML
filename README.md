# HTML Single File Packer

Builds an offline, single-file HTML from an HTML source document. The builder minifies embedded `<style>` blocks with Lightning CSS for Chrome 120, Safari 17, and Firefox 121, removes executable inline script tags from the static markup, and converts the remaining HTML/CSS into a `document.write()` call. It joins the original inline JavaScript in document order with that printer code, applies name and property protection before compilation, then runs Closure Compiler `ADVANCED_OPTIMIZATIONS` exactly once for every input size. All required protection externs are supplied to that same pass, including when the source was already processed by Closure. The generated Roadroller, Base64, and LZMA loaders also run through Closure ADVANCED exactly once. Application scripts run after the markup is written and before `document.close()`, so their `DOMContentLoaded` handlers are registered before the document finishes loading. Roadroller, DEFLATE, and raw LZMA1 are emitted as separate variants. Roadroller uses O1 with 12 contexts below 300,000 input bytes; from 300,000 through 500,000 bytes it uses fixed parameters and 12 contexts; above 500,000 through 1,500,000 bytes it uses fixed parameters and 8 contexts. Above 1,500,000 bytes Roadroller outputs are skipped; the LZMA output is still generated for every input. Its six-bit output symbols are packed into consecutive bytes before Base122 encoding, following the approach in `dist/jsnes-lite.minV14.html`.

The final Base122 loader is optimized in two Closure ADVANCED passes, using a payload placeholder that is filled afterward to avoid Unicode escape expansion. The Roadroller decoder consumes the decoded bytes directly. There is no intermediate character stream, source-code concatenation, or global loader API. Build output reports payload bytes and loader bytes separately. The supplied V14 reference file is left untouched.

For a page with no static application markup whose app is hidden behind `eval(variable)`, optimized variants fall back to encoding the exact input when Closure expands the source. Such a decoder-generated page can depend on the browser's original `document.write()` parser position, which the normal combined loader changes. The build report identifies this as `applicationRuntimeFallback`; Base64, DEFLATE+Base64, and LZMA+Base122 variants then contain the original complete HTML, and `.original.*` outputs remain available as compressed exact-source versions.

## Requirements

- Windows with Node.js 18 or newer
- pnpm (or npm)

## Build the standalone Windows executable

```powershell
npm run build:exe
```

This creates `HtmlSingleFilePack.exe` in the project root. The EXE embeds the Node runtime and the build scripts/dependencies, so the target computer does not need Node.js or npm installed. Run it from the folder containing the source HTML files and project subdirectories; it scans that current folder and writes the normal per-input output folders under `dist/`. It ignores generated/build support directories such as `dist`, `node_modules`, `scripts`, and `.git`. Optional arguments override the input and output folders:

```powershell
HtmlSingleFilePack.exe "C:\\games\\source" "C:\\games\\packed"
```

The first run extracts its embedded runtime to a short, versioned folder under `%LOCALAPPDATA%`; later runs reuse that copy. The executable can be rebuilt after changing the packer by running `npm run build:exe` again.

## Batch-build files in `input`

```powershell
pnpm install
pnpm run build
```

Put standalone HTML files directly in `input/`. Each immediate child directory is treated as one website project: the build finds its entry HTML, inlines linked local JavaScript and stylesheets, embeds referenced local media, fonts and CSS resources (including files in deeper subdirectories), and embeds project image files for both static references and image URLs assigned dynamically through `Image.src`. Local links from one HTML page to another HTML page are converted to in-file navigation; the linked page's scripts, styles and static media are embedded as well. Literal local files passed to `new Audio("file.ext")` in external scripts are embedded. It then produces one set of runnable single-HTML variants under `dist/<directory-name>/`, with the main Roadroller output named `<directory-name>.html`. It also writes `<directory-name>.unoptimized.html`, the fully inlined project before Closure or compression. The entry is a root-level `index.html`/`index.htm` when present; otherwise the project must contain exactly one HTML file. Directories with several HTML files and no root index are reported as ambiguous. Top-level HTML files keep the existing behavior and each build independently. A failure for one input is reported and does not stop the remaining inputs from building. External network resources and external async scripts mixed with other scripts are rejected because their execution order cannot be preserved by combining them.

Each standalone HTML output folder contains a copy of its source HTML. A project output folder contains `<name>.unoptimized.html`, the single-file project with local resources inlined but no code optimization or compression, plus these generated versions, where compilation is supported by the source:

- `<name>.single.html`: Lightning CSS for embedded styles; Closure ADVANCED once -> Roadroller using the size-based O1/context policy above -> Base122. Roadroller decoding is synchronous; the restored application is scheduled after the bootstrap script so `document.open/write` runs after the browser leaves that script. For Roadroller input below 300,000 bytes it keeps the vendored fork's compact `small` decoder context loop; at or above 300,000 bytes it expands the context loop into the faster, larger fast++ decoder.
- `<name>.single.base64.html`: the same Roadroller data and size-selected compact or fast++ decoder -> Base64.
- `<name>.single.regpack.direct.html`: source JavaScript (no Closure/name protection) -> syntax-only whitespace minification -> RegPack.
- `<name>.single.deflate.base64.html`: Lightning CSS for embedded styles; Closure ADVANCED once -> raw DEFLATE -> Base64.
- `<name>.single.lzma.base122.html`: Lightning CSS for embedded styles; Closure ADVANCED once -> raw LZMA1 level 9 -> Base122, with the compact decoder from `vendor/lzma-small-decoder.js`.
- `<name>.single.original.deflate.base64.html`: original HTML bytes -> raw DEFLATE -> Base64.
- `<name>.single.original.deflate.base122.html`: original HTML bytes -> raw DEFLATE -> Base122; its Base122 and raw DEFLATE browser loader is optimized by Closure ADVANCED once.

The direct RegPack output is skipped when its JavaScript input exceeds 8 KiB. Smaller inputs run in a separate process with a 2.5-second limit. A timeout is reported explicitly as `TIMEOUT after 2500 ms`; remaining variants and input files continue building. Roadroller runs in its own process with a 120-second limit; if O1 search times out, its Base122 and Base64 variants are reported as failed while LZMA and other independent outputs continue. Each complete input build also has a 180-second limit. If it expires, the batch reports `timed out after 180 seconds` and continues with the next input.

Build one file explicitly:

```powershell
node scripts/build.mjs path\to\source.html path\to\output.html
```

When only an input path is supplied, the batch wrapper builds that file under `dist/<input-name>/`. When both input and output paths are supplied, it builds that file and writes all variants beside the requested output. With no arguments, it builds top-level HTML files individually and packages each immediate child directory as one website project.

The current sample inputs are the HTML files already in `input/`. The build report checks each output's Base122/Base64/RegPack/DEFLATE decoding round trip and reports generated paths, sizes, the selected Roadroller decoder mode, and its integrated decode time measured in Node/V8. It executes the final Roadroller loader and parses the restored JavaScript.

Roadroller decoders run through the vendored [da0ka fork](https://github.com/da0ka/roadroller). Inputs below 300,000 bytes use its compact `small` decoder context loop; inputs at or above that threshold expand the context loop into fast++ before Closure optimizes the loader. The compression policy uses O1 with 12 contexts below 300,000 bytes, fixed 12-context parameters from 300,000 through 500,000 bytes, fixed 8-context parameters above 500,000 through 1,500,000 bytes, and skips Roadroller above 1,500,000 bytes. LZMA remains enabled for every input. For the 1.44 MB harbor-design application, the eight-context fast++ output was 395,833 bytes versus 433,778 bytes for LZMA, and the integrated fast++ build measured 18.78 seconds for decoding in Node/V8. The earlier six-context prototype measured 11.64 seconds but produced a larger 417,496-byte HTML; the production size policy therefore chooses eight contexts for this input. Browser decode time depends on the device.

The RegPack output is `output.regpack.direct.html`: original application source plus the HTML printer -> syntax-aware formatting -> RegPack -> inline JavaScript. It intentionally skips Closure and does not rename variables or properties; Terser is only used as a JavaScript parser/printer to remove comments and unnecessary whitespace (`compress` and `mangle` are disabled) because RegPack expects compact JavaScript input. RegPack's generated JavaScript is embedded directly without Base64 or a decoding wrapper. The builder checks that the generated JavaScript parses and that HTML parsing preserves the full script.

The fourth output is `output.deflate.base64.html`: Lightning CSS for embedded styles; Closure ADVANCED once -> raw DEFLATE (level 9) -> Base64. Raw DEFLATE omits the two-byte zlib header and four-byte Adler-32 checksum. It uses native `DecompressionStream("deflate-raw")`, `Blob.stream()`, and `Response.text()` before evaluating the decompressed UTF-8 JavaScript. It needs a browser supporting these APIs; it embeds no inflate library and performs no network requests. See the [WHATWG Compression Standard](https://compression.spec.whatwg.org/). Native decompression is asynchronous; the existing application wrapper opens and writes the restored document after decompression.

The LZMA output is `output.lzma.base122.html`: Closure ADVANCED once -> raw LZMA1 (level 9) -> Base122. The builder removes the 13-byte `.lzma` header after encoding and supplies the five LZMA properties and uncompressed byte count in the loader; the payload has no XZ wrapper or checksum. Only the `decodeLzma` data-decoder function from the supplied `lzma-small.js` reference is included. LZMA is not a native `DecompressionStream` format, so this output embeds its decoder. The builder verifies both the package decoder and the supplied browser decoder byte-for-byte.

The original-source DEFLATE outputs are `output.original.deflate.base64.html` and `output.original.deflate.base122.html`: original file bytes -> raw DEFLATE level 9 / memLevel 9 -> Base64 or Base122. They bypass Closure, RegPack, Roadroller, HTML parsing, and name/property protection for the input. The Base122 variant's small decoding loader is Closure ADVANCED-optimized once. The native loader decompresses the original UTF-8 HTML and restores it using `document.open/write/close`; original script tags are executed by the HTML parser. Both compressed payloads are checked byte-for-byte against the input. Existing resource URLs remain in the original document.

To build only this original-file version, run `pnpm run build:original`, or `node scripts/build-original.mjs input.html output.html` with explicit paths. This standalone command only needs Node and its built-in modules. `pnpm run verify:original` checks exact byte restoration using native `DecompressionStream` and checks the document-writing loader. The usual `build` also produces this version before attempting Closure, so a Closure error does not prevent this output from being written.

The report compares all generated HTML variants. `roadrollerDecodeMs` measures the integrated Roadroller loader in Node/V8, including Base122 decoding and Roadroller decompression. `deflateLoaderBytesExcludingPayload` counts the native raw DEFLATE loader including the Base64 decode, stream handling, and evaluation, excluding Base64 content and HTML framing. `lzmaLoaderBytesExcludingPayload` counts the Base122 and raw LZMA1 decoder code, excluding the encoded data literal and HTML framing. `lzmaBase122Bytes` is the encoded UTF-8 payload size before JavaScript-template escaping; `lzmaPayloadLiteralBytes` includes those necessary escapes.

For an independent small demo, run `pnpm run build:regpack-demo` followed by `pnpm run verify:regpack`. This verifies markup output and a Unicode button action in the Roadroller Base122, Roadroller Base64, direct RegPack, and native DEFLATE variants using Node with a simulated DOM.

## Closure externs and scripts that share names

Closure's browser externs are enabled for DOM APIs. Add globals exposed to inline HTML handlers or other browser integrations to `externs/project.externs.js`, along with external library API declarations. For globals defined by an inline script, assign to the externed name (`SharedApi = ...`) instead of declaring it again with `var`.

Application compilation uses `--jscomp_off=undefinedVars` to allow legacy sloppy-mode implicit globals. This suppresses the diagnostic; dynamically generated handlers and string timers still require their referenced names to remain accessible.

Before compilation, the builder parses application JavaScript and quotes object keys and static property accesses. It emits externs for all statically discovered property names in the single Closure pass. This is needed when a runtime-built key such as `"rotor"+index` must match an object property that is also referenced statically elsewhere; otherwise ADVANCED can rename one side but cannot infer the dynamic relationship. This also protects string dictionaries such as `PIECES[piece]`, JSON field names, and class callbacks. ADVANCED variable and control-flow optimizations remain enabled. Names declared by the application and referenced in inline HTML event attributes (such as `onclick="newGame()"`) are automatically exported to `globalThis`.

Automatic name protection scans HTML event handlers and code passed literally to `eval`, `Function`, `setTimeout`, and `setInterval`; ordinary display strings are not treated as JavaScript names. This covers handlers generated via `innerHTML`/`document.write`, string timers, and dynamically generated code such as TinyNES's CPU instructions. Matching top-level functions are exported, while referenced top-level `var` bindings are preserved as global externs without self-referential accessors. Mutable `let` bindings use global getters/setters so string code observes and changes the current value; constants get getters only. The build report lists `protectedGlobals` and `protectedVarGlobals`. Names assembled entirely from runtime input cannot always be inferred.

`pnpm run verify:protection` checks these bindings, class methods, and dynamically assembled property access through the one Closure ADVANCED pass. For the current 1.25K chess input, `pnpm run verify` compares all three output versions with the source, including dynamic HTML click handlers, a pawn move, and the string-timer AI reply (Node with simulated DOM).

For the current chess demo, verification compares source and packed execution: all 32 piece glyphs, e2-e4, an AI reply, and the New Game reset. This runs in Node with a simulated DOM.

Non-JavaScript script data such as JSON and import maps remain in the printed markup. Inline JavaScript modules (`type="module"`) are rejected. The combined application code runs after the printed markup is restored and before `DOMContentLoaded`, allowing the original scripts to register their DOM-ready handlers normally; individual inline script timing and scope therefore become one combined execution. For directory projects, local images are embedded and their URLs are redirected when used through `Image.src` or dynamically assigned CSS. Runtime `fetch()` GET requests are also routed to embedded local files, including binary files returned as byte streams; text resources requested through `XMLHttpRequest` continue to use the local-file shim. External URLs and unsupported request methods still need source-level handling.

## Offline and browser notes

All decoder code and encoded script data are embedded in the generated HTML. The Base122 payload is stored in a JavaScript template literal so valid Base122 control characters stay as single characters instead of expanding into `\\u00xx` escapes. The builder escapes template delimiters and any `</script` sequence needed to keep the HTML parser safe. The output uses `eval` and `Function`, as Roadroller's decoder does, so a Content Security Policy must permit inline scripts and `unsafe-eval`. Do not use this for untrusted HTML or JavaScript.

The browser-based file-open check could not be completed in this environment: its browser automation policy rejects `file:` URLs and disallows serving the local file as a workaround. `pnpm run verify` executes the generated decoder and packed code in Node's JavaScript engine with a simulated DOM; it checks the single Roadroller payload, one HTML print operation, and the demo button behavior. This verifies the decode/execute path but is not a substitute for an actual browser run.

## Vendored Base122 code

The Base122 encoder and browser decoder are adapted from [Kevin Albertson's Base122 project](https://github.com/kevinAlbs/Base122), licensed under MIT; see `vendor/base122-LICENSE.txt`. Build dependencies and exact versions are recorded in `package.json` and `pnpm-lock.yaml`.




