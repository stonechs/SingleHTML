# HTML Single File Packer

English | [简体中文](#简体中文)

Builds an offline, single-file HTML from an HTML source document. The builder minifies embedded `<style>` blocks with Lightning CSS for Chrome 120, Safari 17, and Firefox 121, removes executable inline script tags from the static markup, and converts the remaining HTML/CSS into a `document.write()` call. It joins the original inline JavaScript in document order with that printer code, applies name and property protection before compilation, then runs Closure Compiler `ADVANCED_OPTIMIZATIONS` exactly once for every input size. All required protection externs are supplied to that same pass, including when the source was already processed by Closure. The generated Roadroller, Base64, and LZMA loaders also run through Closure ADVANCED exactly once. Application scripts run after the markup is written and before `document.close()`, so their `DOMContentLoaded` handlers are registered before the document finishes loading. Roadroller, DEFLATE, and raw LZMA1 are emitted as separate variants. Roadroller uses O1 with 12 contexts below 300,000 input bytes; from 300,000 through 500,000 bytes it uses fixed parameters and 12 contexts; above 500,000 through 1,500,000 bytes it uses fixed parameters and 8 contexts. Above 1,500,000 bytes Roadroller outputs are skipped; the LZMA output is still generated for every input. Its six-bit output symbols are packed into consecutive bytes before Base122 encoding, following the approach in `dist/jsnes-lite.minV14.html`.

The final Base122 loader is optimized in one Closure ADVANCED pass. Its payload placeholder is filled afterward to avoid Unicode escape expansion. The Roadroller decoder consumes the decoded bytes directly. There is no intermediate character stream, source-code concatenation, or global loader API. Build output reports payload bytes and loader bytes separately. The supplied V14 reference file is left untouched.

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

Install dependencies once in the project directory before building. `npm run build` only starts the builder; it does not install packages. Choose one package manager and use it for both commands:

```powershell
# pnpm
pnpm install
pnpm run build

# npm
npm install
npm run build
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

## 简体中文

本工具可将 HTML 源文件打包为完全离线的单文件 HTML。构建器使用 Lightning CSS 压缩内嵌的 `<style>`（目标浏览器为 Chrome 120、Safari 17 和 Firefox 121），从静态标记中移除可执行的内联脚本，并将剩余 HTML/CSS 转换为 `document.write()` 调用。然后按照文档顺序把原有内联 JavaScript 与打印代码合并，在编译前保护名称和属性，并对所有输入大小统一运行一遍 Closure Compiler `ADVANCED_OPTIMIZATIONS`。所有必要的保护 externs 都在这同一遍编译中提供，即使输入本身已经经过 Closure 处理也一样。生成的 Roadroller、Base64 和 LZMA 加载器也各自只经过一遍 Closure ADVANCED。应用脚本在标记写入后、`document.close()` 前执行，以便它们能在文档完成加载前注册 `DOMContentLoaded` 处理器。Roadroller、DEFLATE 和 raw LZMA1 会分别生成不同版本。Roadroller 对小于 300,000 字节的输入使用 O1 和 12 个上下文；300,000 至 500,000 字节使用固定参数和 12 个上下文；大于 500,000 且不超过 1,500,000 字节使用固定参数和 8 个上下文。超过 1,500,000 字节时跳过 Roadroller 输出，但仍为每个输入生成 LZMA 版本。Base122 编码前，会把每个 6 位输出符号连续打包为字节，方法参考 `dist/jsnes-lite.minV14.html`。

最终的 Base122 加载器只经过一遍 Closure ADVANCED 优化。为避免 Unicode 转义扩展，编译时先保留 payload 占位符，优化完成后再填入实际数据。Roadroller 解码器直接消费解码得到的字节。流程中没有中间字符流、源码拼接或全局加载器 API。构建报告会分别列出 payload 和加载器的字节数。提供的 V14 参考文件不会被修改。

如果页面没有静态应用标记，且应用隐藏在 `eval(variable)` 中，当 Closure 输出比原始源码更大时，优化版本会退回到对完整原始输入进行编码。这类由解码器生成的页面可能依赖浏览器原本的 `document.write()` 解析位置，而普通合并加载器会改变该位置。构建报告会将此情况标记为 `applicationRuntimeFallback`；此时 Base64、DEFLATE+Base64 和 LZMA+Base122 版本会包含完整原始 HTML，`.original.*` 版本也会继续保留压缩后的原始文件。

## 环境要求

- Windows，Node.js 18 或更新版本
- pnpm（或 npm）

## 构建独立 Windows 可执行文件

```powershell
npm run build:exe
```

该命令会在项目根目录生成 `HtmlSingleFilePack.exe`。EXE 内含 Node.js 运行时、构建脚本和依赖，因此目标电脑无需另行安装 Node.js 或 npm。请在包含 HTML 源文件及项目子目录的文件夹中运行它；程序会扫描当前文件夹，并将每个输入对应的输出目录写入 `dist/`。扫描时会忽略 `dist`、`node_modules`、`scripts` 和 `.git` 等构建辅助目录。也可以通过可选参数指定输入和输出目录：

```powershell
HtmlSingleFilePack.exe "C:\\games\\source" "C:\\games\\packed"
```

首次运行时，程序会把内嵌运行时解压到 `%LOCALAPPDATA%` 下一个带版本号的短路径；之后的运行会复用该副本。修改打包器后，可再次运行 `npm run build:exe` 重建可执行文件。

## 批量构建 `input` 中的文件

首次构建前，请先在项目目录安装依赖。`npm run build` 只会启动构建脚本，不会自动安装依赖。选择一种包管理器，并用它执行两条命令：

```powershell
# pnpm
pnpm install
pnpm run build

# npm
npm install
npm run build
```

独立 HTML 文件直接放在 `input/` 中。`input/` 下的每个一级子目录都会作为一个网站项目处理：构建器会查找入口 HTML，内嵌本地 JavaScript 和样式表，嵌入引用到的本地媒体、字体和 CSS 资源（包括更深层子目录中的文件），并嵌入项目图片，包括静态引用的图片以及通过 `Image.src` 动态设置 URL 的图片。HTML 页面之间的本地链接会转换为文件内导航；被链接页面的脚本、样式和静态媒体也会一并嵌入。外部脚本中以字面量传给 `new Audio("file.ext")` 的本地文件同样会嵌入。构建完成后，每个项目会在 `dist/<目录名>/` 下生成一组可运行的单 HTML 版本，主要 Roadroller 输出文件命名为 `<目录名>.html`。此外还会输出 `<目录名>.unoptimized.html`，即已内嵌资源、但未做 Closure 或压缩的项目版本。入口优先使用项目根目录下的 `index.html` 或 `index.htm`；否则项目必须只有一个 HTML 文件。若没有根目录 index 且存在多个 HTML 文件，构建器会报告入口不明确。`input/` 顶层的 HTML 文件仍按原有方式分别构建。某个输入失败会单独报告，不会中止其他输入的构建。如果外部网络资源无法内嵌，或外部 async 脚本与其他脚本混用而无法保持执行顺序，构建器会拒绝处理。

每个独立 HTML 的输出目录都会包含一份原始源 HTML。项目目录的输出中会有 `<name>.unoptimized.html`（已内嵌本地资源，但未做代码优化或压缩），以及以下适用于该源文件的版本：

- `<name>.single.html`：Lightning CSS 处理内嵌样式；Closure ADVANCED 一遍 -> 按上述 O1/上下文策略运行 Roadroller -> Base122。Roadroller 同步解码；恢复应用时会等引导脚本退出后再调用 `document.open/write`。Roadroller 输入小于 300,000 字节时使用 vendored fork 中紧凑的 `small` 上下文循环；达到或超过该大小时，会将循环展开为速度更快、体积更大的 fast++ 解码器。
- `<name>.single.base64.html`：使用相同的 Roadroller 数据和按大小选择的 compact 或 fast++ 解码器，再进行 Base64 编码。
- `<name>.single.regpack.direct.html`：原始 JavaScript（不经过 Closure 或名称保护）-> 仅做语法安全的空白压缩 -> RegPack。
- `<name>.single.deflate.base64.html`：Lightning CSS 处理内嵌样式；Closure ADVANCED 一遍 -> raw DEFLATE -> Base64。
- `<name>.single.lzma.base122.html`：Lightning CSS 处理内嵌样式；Closure ADVANCED 一遍 -> raw LZMA1 level 9 -> Base122，使用 `vendor/lzma-small-decoder.js` 中的紧凑解码器。
- `<name>.single.original.deflate.base64.html`：原始 HTML 字节 -> raw DEFLATE -> Base64。
- `<name>.single.original.deflate.base122.html`：原始 HTML 字节 -> raw DEFLATE -> Base122；其 Base122 和 raw DEFLATE 浏览器加载器经过一遍 Closure ADVANCED 优化。

RegPack 版本在 JavaScript 输入超过 8 KiB 时会跳过。较小输入会在独立进程中运行，限时 2.5 秒；超时会明确报告 `TIMEOUT after 2500 ms`，其余版本和输入仍继续处理。Roadroller 在独立进程中运行，限时 120 秒；若 O1 搜索超时，Roadroller 的 Base122 和 Base64 版本会报告失败，但 LZMA 和其他独立输出仍会继续。每个输入的完整构建另有 180 秒时限；若超时，会报告 `timed out after 180 seconds` 并继续构建下一个输入。

显式构建单个文件：

```powershell
node scripts/build.mjs path\to\source.html path\to\output.html
```

只提供输入路径时，批量构建器会将文件构建到 `dist/<输入名>/`。同时提供输入和输出路径时，会构建该文件并把所有版本写到指定输出文件旁边。不带参数时，会分别构建顶层 HTML 文件，并把每个一级子目录作为一个网站项目打包。

当前示例输入是 `input/` 中的 HTML 文件。构建报告会检查各输出的 Base122、Base64、RegPack 和 DEFLATE 解码往返，并列出生成路径、文件大小、所选 Roadroller 解码模式，以及在 Node/V8 中测得的整合解码时间。它还会执行最终 Roadroller 加载器并解析恢复后的 JavaScript。

Roadroller 解码器基于 vendored [da0ka fork](https://github.com/da0ka/roadroller)。输入小于 300,000 字节时使用紧凑的 `small` 上下文循环；达到或超过该阈值时，会在 Closure 优化加载器前展开循环以生成 fast++。压缩策略为：小于 300,000 字节使用 O1 和 12 个上下文；300,000 至 500,000 字节使用固定参数和 12 个上下文；大于 500,000 且不超过 1,500,000 字节使用固定参数和 8 个上下文；超过 1,500,000 字节时跳过 Roadroller。所有输入仍会生成 LZMA 版本。对于 1.44 MB 的港口设计应用，8 上下文 fast++ 输出为 395,833 字节，LZMA 输出为 433,778 字节；fast++ 整合构建在 Node/V8 中的解码时间为 18.78 秒。早期 6 上下文原型解码耗时 11.64 秒，但生成的 HTML 更大，为 417,496 字节，因此当前策略为该输入选择 8 个上下文。浏览器解码时间取决于设备。

RegPack 输出为 `output.regpack.direct.html`：原始应用源码加 HTML 打印代码 -> 语法感知的格式化 -> RegPack -> 内联 JavaScript。该版本有意跳过 Closure，也不改写变量名或属性名；由于 RegPack 需要紧凑的 JavaScript 输入，Terser 仅作为 JavaScript 解析器和打印器移除注释及多余空白（关闭 `compress` 和 `mangle`）。RegPack 生成的 JavaScript 会直接嵌入，不经过 Base64，也没有解码包装器。构建器会检查生成的 JavaScript 能否解析，以及 HTML 解析是否保留了完整脚本。

第四种输出为 `output.deflate.base64.html`：Lightning CSS 处理内嵌样式；Closure ADVANCED 一遍 -> raw DEFLATE（level 9）-> Base64。Raw DEFLATE 不含 2 字节的 zlib 头和 4 字节的 Adler-32 校验值。它使用原生 `DecompressionStream("deflate-raw")`、`Blob.stream()` 和 `Response.text()`，解压 UTF-8 JavaScript 后再执行。浏览器必须支持这些 API；该版本不内嵌 inflate 库，也不发起网络请求。详见 [WHATWG Compression Standard](https://compression.spec.whatwg.org/)。原生解压是异步的，因此现有应用包装器会在解压完成后再打开并写入文档。

LZMA 输出为 `output.lzma.base122.html`：Closure ADVANCED 一遍 -> raw LZMA1（level 9）-> Base122。构建器编码后会移除 13 字节的 `.lzma` 头，并在加载器中提供 5 个 LZMA 属性和未压缩字节数；payload 不含 XZ 容器或校验和。只会合入所提供 `lzma-small.js` 参考代码中的 `decodeLzma` 数据解码函数。LZMA 不是原生 `DecompressionStream` 格式，所以该版本会内嵌其解码器。构建器会逐字节验证库解码器和所提供的浏览器解码器。

原始源码 DEFLATE 输出为 `output.original.deflate.base64.html` 和 `output.original.deflate.base122.html`：原始文件字节 -> raw DEFLATE level 9 / memLevel 9 -> Base64 或 Base122。输入文件本身不会经过 Closure、RegPack、Roadroller、HTML 解析或名称/属性保护。Base122 版本的小型解码加载器会经过一遍 Closure ADVANCED 优化。原生加载器会解压原始 UTF-8 HTML，并通过 `document.open/write/close` 恢复；原始脚本标签由 HTML 解析器执行。两个压缩 payload 都会与输入逐字节比对。原文已有的资源 URL 保持不变。

只构建原始文件版本，可运行 `pnpm run build:original`，或使用 `node scripts/build-original.mjs input.html output.html` 指定输入和输出路径。该独立命令只需要 Node.js 内置模块。`pnpm run verify:original` 使用原生 `DecompressionStream` 检查字节级恢复，并验证写入文档的加载器。普通 `build` 也会先生成此版本，因此即使 Closure 报错，这个输出仍会保留。

报告会比较所有生成的 HTML 版本。`roadrollerDecodeMs` 测量 Node/V8 中整合的 Roadroller 加载器耗时，包括 Base122 解码和 Roadroller 解压。`deflateLoaderBytesExcludingPayload` 统计原生 raw DEFLATE 加载器大小，包括 Base64 解码、流处理和执行，但不含 Base64 内容和 HTML 框架。`lzmaLoaderBytesExcludingPayload` 统计 Base122 和 raw LZMA1 解码代码大小，不含编码数据和 HTML 框架。`lzmaBase122Bytes` 是 JavaScript 模板转义前的 UTF-8 编码 payload 大小；`lzmaPayloadLiteralBytes` 包含必要的转义。

独立的小型示例可运行 `pnpm run build:regpack-demo`，随后运行 `pnpm run verify:regpack`。该验证使用带模拟 DOM 的 Node，检查 Roadroller Base122、Roadroller Base64、直接 RegPack 和原生 DEFLATE 版本的标记输出及 Unicode 按钮行为。

## Closure externs 与共享名称的脚本

Closure 已启用浏览器 DOM API externs。若内联 HTML 处理器或其他浏览器集成会访问某个全局变量，请将其与外部库 API 声明一起添加到 `externs/project.externs.js`。若全局变量由内联脚本定义，请对 extern 声明的名称赋值（例如 `SharedApi = ...`），不要再用 `var` 重新声明。

应用编译使用 `--jscomp_off=undefinedVars`，以兼容旧式 sloppy mode 中未显式声明的全局变量。这会关闭相应诊断，但动态生成的处理器和字符串定时器仍要求其引用的名称保持可访问。

编译前，构建器会解析应用 JavaScript，并为对象键和静态属性访问加引号。它会在唯一的一遍 Closure 编译中为静态发现的属性名生成 externs。当运行时拼出的键（例如 `"rotor"+index`）需要匹配其他位置静态引用的对象属性时，这一步可以避免 ADVANCED 只改写一侧名称、无法推断动态对应关系的问题。它也会保护 `PIECES[piece]` 这类字符串字典、JSON 字段名和类回调。ADVANCED 变量和控制流优化仍保持启用。若应用声明的名称被内联 HTML 事件属性引用（例如 `onclick="newGame()"`），会自动导出到 `globalThis`。

自动名称保护会扫描 HTML 事件处理器，以及字面量传入 `eval`、`Function`、`setTimeout` 和 `setInterval` 的代码；普通显示字符串不会被当作 JavaScript 名称处理。这可以覆盖由 `innerHTML`/`document.write` 生成的处理器、字符串定时器，以及 TinyNES CPU 指令等动态代码。匹配到的顶层函数会被导出；被引用的顶层 `var` 会作为全局 extern 保留，不会生成自引用访问器。可变的 `let` 会使用全局 getter/setter，让字符串代码能读取和修改当前值；常量只生成 getter。构建报告会列出 `protectedGlobals` 和 `protectedVarGlobals`。完全由运行时输入拼接出的名称不一定能自动推断。

`pnpm run verify:protection` 会检查这些绑定、类方法和动态拼接属性访问是否能通过一遍 Closure ADVANCED 编译。对于当前 1.25 KB 的国际象棋输入，`pnpm run verify` 会在带模拟 DOM 的 Node 中比较源文件和三个输出版本，包括动态 HTML 点击处理器、兵从 e2 走到 e4，以及由字符串定时器触发的 AI 应答。

当前棋类示例的验证还会比较源文件和打包后的执行：检查 32 个棋子字符、e2-e4、AI 应答和 New Game 重置。此验证同样在带模拟 DOM 的 Node 中运行。

JSON 和 import map 等非 JavaScript 脚本数据仍保留在打印出的标记中。内联 JavaScript 模块（`type="module"`）不受支持。组合后的应用代码会在标记恢复后、`DOMContentLoaded` 触发前运行，使原脚本能正常注册 DOM 就绪处理器；因此，原来各个内联脚本的执行时序和作用域会合并为一次执行。对于目录项目，本地图片会被嵌入；通过 `Image.src` 或动态 CSS 设置的图片 URL 也会被重定向到内嵌资源。运行时的 `fetch()` GET 请求同样会路由到本地内嵌文件，包括以字节流返回的二进制文件；文本资源的 `XMLHttpRequest` 继续由本地文件 shim 处理。外部 URL 和不支持的请求方法仍需在源代码中自行处理。

## 离线与浏览器说明

所有解码器代码和编码后的脚本数据都嵌入生成的 HTML。Base122 payload 存放在 JavaScript 模板字符串中，使有效的 Base122 控制字符保持为单个字符，而不扩展成 `\\u00xx` 转义。构建器会转义模板字符串分隔符，以及可能影响 HTML 解析的 `</script` 序列。输出使用 `eval` 和 `Function`（Roadroller 解码器也会使用），因此内容安全策略必须允许内联脚本及 `unsafe-eval`。请勿用此工具处理不可信的 HTML 或 JavaScript。

当前环境中的浏览器自动化策略拒绝 `file:` URL，也不允许通过本地服务器绕过，因此无法完成浏览器直接打开文件的检查。`pnpm run verify` 会在 Node 的 JavaScript 引擎中配合模拟 DOM 执行生成的解码器和打包代码，检查单个 Roadroller payload、一次 HTML 打印操作及示例按钮行为。它能验证解码和执行流程，但不能替代真实浏览器运行。

## Vendored Base122 代码

Base122 编码器和浏览器解码器改编自 [Kevin Albertson 的 Base122 项目](https://github.com/kevinAlbs/Base122)，采用 MIT 许可证，详见 `vendor/base122-LICENSE.txt`。构建依赖及其准确版本记录在 `package.json` 和 `pnpm-lock.yaml` 中。





