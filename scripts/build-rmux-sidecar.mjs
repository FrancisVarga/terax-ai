/**
 * Compile the `rmux-daemon` Rust sidecar and stage it as a Tauri externalBin
 * under `src-tauri/binaries/`.
 *
 * Why a separate script (not part of `pnpm tauri build`): Tauri's `externalBin`
 * mechanism expects the sidecar already present on disk, suffixed with the
 * target triple (e.g. `-x86_64-pc-windows-msvc`), before the bundler runs. The
 * bundler strips the triple at install and the app resolves the bare name
 * (`rmux-daemon`) next to its own executable (modules/rmux find_sidecar).
 *
 * The sidecar is its OWN workspace-member crate (`src-tauri/rmux-daemon/`) that
 * path-depends on `terax_lib` for the shared PTY core. It is built with
 * `terax_lib`'s DEFAULT features only (no `sql`/DuckDB) so the slow C++
 * amalgamation is never pulled into the sidecar. The workspace shares one
 * `target/` dir, so the output path is unchanged.
 *
 * Run via the `build:sidecars` chain, BEFORE `pnpm tauri build`.
 * Cross-compile by passing --target=<triple>; defaults to the host triple.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const OUT_DIR = join(SRC_TAURI, "binaries");

const EXE = process.platform === "win32" ? ".exe" : "";

/** The cargo bin name + the Tauri externalBin base (must match tauri.conf.json). */
const BIN_NAME = "rmux-daemon";

/** Resolve the host target triple via `rustc -vV`, the same value Tauri uses. */
function hostTriple() {
  const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) {
    const m = r.stdout.match(/^host:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const argTriple = process.argv.find((a) => a.startsWith("--target="));
// Resolution order: explicit `--target=` flag wins (the `build:sidecars` chain and
// the CI step both pass it); else the TERAX_SIDECAR_TARGET env var (a fallback for
// an arg-less invocation on a cross-compile row); else the host triple.
// MUST mirror the sibling sidecar scripts: if rmux builds for the host triple
// while bunqueue/otel/kv/localfs staged for the cross target, the terax build.rs
// externalBin assertion (triggered by `cargo build -p rmux-daemon`) fails on the
// peer sidecars that were never staged for rmux's host triple.
const triple = argTriple
  ? argTriple.slice("--target=".length)
  : process.env.TERAX_SIDECAR_TARGET || hostTriple();

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`Building ${BIN_NAME} sidecar for ${triple}`);

const staged = join(OUT_DIR, `${BIN_NAME}-${triple}${EXE}`);

// Bootstrap: `rmux-daemon` path-depends on `terax_lib`, so building
// `-p rmux-daemon` compiles the `terax` package, whose `tauri-build` build.rs
// asserts EVERY `externalBin` file exists, including `rmux-daemon` itself. Stage
// a zero-byte placeholder so build.rs passes, then overwrite it with the real
// output below. (build-sidecars.mjs also stages this up front so a clean chain
// never trips an earlier sidecar's build on a missing rmux-daemon placeholder.)
if (!existsSync(staged)) {
  writeFileSync(staged, "");
}

const buildArgs = ["build", "--release", "-p", BIN_NAME, "--target", triple];
const build = spawnSync("cargo", buildArgs, { stdio: "inherit", cwd: SRC_TAURI });
if (build.status !== 0) {
  console.error(`cargo build failed for ${BIN_NAME} (exit ${build.status})`);
  process.exit(build.status ?? 1);
}

const built = join(SRC_TAURI, "target", triple, "release", `${BIN_NAME}${EXE}`);
if (!existsSync(built)) {
  console.error(`Expected build output missing: ${built}`);
  process.exit(1);
}

copyFileSync(built, staged);
console.log(`Staged sidecar: ${staged}`);
