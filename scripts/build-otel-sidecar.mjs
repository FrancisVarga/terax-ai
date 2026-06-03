/**
 * Compile the `otel-collector` Rust sidecar and stage it as a Tauri externalBin
 * under `src-tauri/binaries/`.
 *
 * Why a separate script (not part of `pnpm tauri build`): Tauri's `externalBin`
 * mechanism expects the sidecar already present on disk, suffixed with the
 * target triple (e.g. `-x86_64-pc-windows-msvc`), before the bundler runs. The
 * bundler strips the triple at install and the app resolves the bare name
 * (`otel-collector`) next to its own executable.
 *
 * The sidecar is its OWN workspace-member crate (`src-tauri/otel-collector/`)
 * that path-depends on `terax_lib` for the shared collector core. It is built
 * with `terax_lib`'s DEFAULT features only — NOT `--features sql` — so the
 * DuckDB C++ amalgamation (the ~1h build hot path, see Cargo.toml + issue #72)
 * is never pulled into the sidecar. The sidecar only needs rusqlite + hyper +
 * opentelemetry-proto, all in the default build. The workspace shares one
 * `target/` dir, so the output path is unchanged.
 *
 * Run via: `pnpm build:otel-sidecar` (called from `pretauri`). Run BEFORE
 * `pnpm tauri build`. Cross-compile by passing --target=<triple>; defaults to
 * the host triple.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const OUT_DIR = join(SRC_TAURI, "binaries");

const EXE = process.platform === "win32" ? ".exe" : "";

/** The cargo bin name + the Tauri externalBin base (must match tauri.conf.json). */
const BIN_NAME = "otel-collector";

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

// `otel-collector` is now a separate workspace-member crate, so it no longer
// runs `terax`'s `build.rs` (which asserts every externalBin exists). No
// placeholder bootstrap is needed: just build the member package and stage it.
//
// Default features only (no `sql`/DuckDB). `--target` makes the output path
// deterministic across host and cross builds. Run from `src-tauri` so the
// workspace is found; `-p otel-collector` selects the member package.
const buildArgs = [
  "build",
  "--release",
  "-p",
  BIN_NAME,
  "--target",
  triple,
];
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
