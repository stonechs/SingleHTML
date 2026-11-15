# V2 bugfix build snapshot

This directory is an immutable snapshot of the build and verification scripts at the V2 bugfix release point (2026-11-14).

It includes the current top-level files from `scripts/`, including the project bundler, HTML build pipeline, workers, verification scripts, and Windows launcher sources. `SHA256SUMS.txt` records SHA-256 hashes for every script file in this snapshot; the manifest does not hash itself or this README.

Restore a script by copying it from this directory to its original location under `scripts/`. The archived files are a reference snapshot; `npm run build` continues to use the live scripts at the root of `scripts/`.
