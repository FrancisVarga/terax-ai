/**
 * Compile the `localfs` Rust sidecar (a local-only, 100% S3-compatible object
 * store — a smaller RustFS) and stage it as a Tauri externalBin under
 * `src-tauri/binaries/`.
 *
 * Why a separate script (not part of `pnpm tauri build`): Tauri's `externalBin`
 * mechanism expects the sidecar already present on disk, suffixed with the
 * target triple (e.g. `-x86_64-pc-windows-msvc`), before the bundler runs. The
 * bundler strips the triple at install and the app resolves the bare name
 * (`localfs`) next to its own executable.
 *
 * Unlike `build-otel-sidecar.mjs`, `localfs` is a STANDALONE crate (no path dep
 * on `terax_lib`) built over the published `s3s-fs` library. Building
 * `-p localfs` therefore does NOT compile the `terax` package. The zero-byte
 * placeholder below is still required, but for a different build: the main
 * crate's `tauri-build` build.rs (run by `pnpm tauri build` / `cargo build -p
 * terax`) asserts that EVERY `externalBin` file already exists on disk —
 * including `localfs`. Staging the placeholder first satisfies that assertion;
 * this script then overwrites it with the real binary.
 *
 * Keeping `localfs` a separate workspace member (rather than a `[[bin]]` of the
 * main crate) is also what avoids the WiX MSI ICE30 duplicate-component error.
 *
 * Run via: `pnpm build:localfs-sidecar` (or the `build:sidecars` chain). Run BEFORE
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
const BIN_NAME = "localfs";

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
const triple = argTriple
  ? argTriple.slice("--target=".length)
  : process.env.TERAX_SIDECAR_TARGET || hostTriple();

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`Building ${BIN_NAME} sidecar for ${triple}`);

const staged = join(OUT_DIR, `${BIN_NAME}-${triple}${EXE}`);

// Bootstrap placeholder so the main crate's `tauri-build` externalBin assertion
// passes on the next `cargo build -p terax` / `pnpm tauri build`. Overwritten
// with the real output below.
if (!existsSync(staged)) {
  writeFileSync(staged, "");
}

// `--target` makes the output path deterministic across host and cross builds.
// Run from `src-tauri` so the workspace is found; `-p localfs` selects the
// member package.
const buildArgs = ["build", "--release", "-p", BIN_NAME, "--target", triple];
const build = spawnSync("cargo", buildArgs, { stdio: "inherit", cwd: SRC_TAURI });
if (build.status !== 0) {
  console.error(`cargo build failed for ${BIN_NAME} (exit ${build.status})`);
  process.exit(build.status ?? 1);
}

// `cargo build --target <triple>` emits under target/<triple>/release/.
const built = join(SRC_TAURI, "target", triple, "release", `${BIN_NAME}${EXE}`);
if (!existsSync(built)) {
  console.error(`Expected build output missing: ${built}`);
  process.exit(1);
}

copyFileSync(built, staged);
console.log(`Staged sidecar: ${staged}`);
