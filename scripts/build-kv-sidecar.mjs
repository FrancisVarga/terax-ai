/**
 * Compile the `kv-server` Rust sidecar and stage it as a Tauri externalBin
 * under `src-tauri/binaries/`.
 *
 * Mirrors `build-otel-sidecar.mjs`. The sidecar is its OWN workspace-member
 * crate (`src-tauri/kv-server/`) that path-depends on `terax_lib` for the shared
 * KV core (store + RESP codec + dispatch + serve loop + snapshot). It is built
 * with `terax_lib`'s DEFAULT features only (no `--features sql`, so the DuckDB
 * C++ amalgamation is never pulled in). The workspace shares one `target/` dir.
 *
 * Run via: `pnpm build:kv-sidecar` (called from `pretauri`). Run BEFORE
 * `pnpm tauri build`. Cross-compile by passing --target=<triple>; defaults to
 * the host triple.
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
const BIN_NAME = "kv-server";

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
const triple = argTriple ? argTriple.slice("--target=".length) : hostTriple();

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`Building ${BIN_NAME} sidecar for ${triple}`);

const staged = join(OUT_DIR, `${BIN_NAME}-${triple}${EXE}`);

// Bootstrap: `kv-server` path-depends on `terax_lib`, so building it compiles
// the `terax` package, whose `tauri-build` build.rs asserts EVERY `externalBin`
// file exists - including `kv-server` itself. Stage a zero-byte placeholder so
// build.rs passes, then overwrite it with the real output below. (The separate
// crate avoids the WiX MSI ICE30 duplicate-component error; this placeholder
// handles the distinct build-time externalBin assertion.)
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
