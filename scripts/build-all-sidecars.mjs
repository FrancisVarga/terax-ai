/**
 * Orchestrate the full sidecar build in the one correct order, so `build:sidecars`
 * and `pretauri` stay one-liners instead of a duplicated `A && B && C && ...`
 * chain that has to be edited in two places every time a sidecar is added.
 *
 * Order matters and is encoded here once:
 *  1. build-sidecars       - compiles the Bun sidecars AND stages zero-byte
 *                            placeholders for every Rust externalBin up front, so
 *                            no later per-sidecar cargo build trips terax's
 *                            build.rs externalBin assertion on a not-yet-staged
 *                            peer (see scripts/build-sidecars.mjs + the
 *                            externalbin-placeholder-ordering note).
 *  2. fetch-sidecar-binaries - downloads the prebuilt third-party binaries (rg, s5cmd).
 *  3. build-<rust> sidecars  - otel-collector, kv-server, localfs, rmux-daemon:
 *                            each compiles its crate and overwrites its placeholder
 *                            with the real binary.
 *
 * Each step runs as its own `node` process so its `process.exit` semantics and
 * stdio are preserved; a non-zero exit stops the run, matching the old `&&` chain.
 * Pass-through args (e.g. --target=<triple>) are forwarded to every step.
 *
 * Run via: `pnpm build:sidecars` (and automatically by `pretauri`).
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Forward any extra args (e.g. --target=aarch64-apple-darwin) to every step.
const passthrough = process.argv.slice(2);

const STEPS = [
  "build-sidecars.mjs",
  "fetch-sidecar-binaries.mjs",
  "build-otel-sidecar.mjs",
  "build-kv-sidecar.mjs",
  "build-localfs-sidecar.mjs",
  "build-rmux-sidecar.mjs",
];

for (const step of STEPS) {
  const script = join(__dirname, step);
  console.log(`\n=== sidecars: ${step} ===`);
  const r = spawnSync(process.execPath, [script, ...passthrough], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`sidecar step failed: ${step} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

console.log("\nAll sidecars built and staged.");
