# V1 build script snapshot

Frozen copy of the project build and verification scripts for the finalized V1 pipeline (2026-11-14).

This folder is a backup, not a standalone runnable copy: the scripts resolve dependencies and project paths relative to their normal `scripts/` location. To restore V1, copy the `.mjs` files back to `scripts/`. The matching dependency versions remain recorded in the project-root `package.json` and `pnpm-lock.yaml`.

The V1 application pipeline uses one Closure ADVANCED pass per compilation input, protects globals and dynamic-code names before that pass, then emits the configured Roadroller, Base122, Base64, DEFLATE, and LZMA variants.

`SHA256SUMS.txt` contains SHA-256 hashes for every archived `.mjs` file.
