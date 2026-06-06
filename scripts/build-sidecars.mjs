/**
 * Compile the bunqueue server CLI and its worker scripts into standalone Bun
 * executables, and stage them as Tauri sidecars under `src-tauri/binaries/`.
 *
 * Why: bunqueue is Bun-only and ships as plain JS in node_modules. A packaged
 * Terax build has neither node_modules nor a system Bun, so the dev-time
 * "walk up to node_modules + run `bun`" strategy can't work in production.
 * `bun build --compile` embeds the Bun runtime AND the bundled code into one
 * exe, removing both dependencies at once.
 *
 * Tauri's `externalBin` mechanism requires each sidecar be suffixed with the
 * target triple (e.g. `-x86_64-pc-windows-msvc`); the bundler strips it at
 * install and the app resolves the bare name next to its own executable.
 *
 * Run via: `pnpm build:sidecars` (which calls `bun scripts/build-sidecars.mjs`).
 * Run BEFORE `pnpm tauri build`. Cross-compile by passing --target=<triple>;
 * defaults to the host triple.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "src-tauri", "binaries");

const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * Resolve a real Bun executable, NOT the placeholder stub that pnpm leaves in
 * node_modules/.bin when bun's binary-download postinstall is skipped (the
 * `bunqueue` dependency only needs Bun's JS, so we disable that postinstall in
 * pnpm-workspace.yaml). Running scripts via pnpm prepends node_modules/.bin to
 * PATH, so a bare "bun" would hit the ~450-byte stub and fail with "not
 * compatible with the version of Windows you're running". Walk PATH and pick
 * the first bun that is a plausibly-real binary (skip the tiny stub).
 */
function resolveBun() {
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    // pnpm injects node_modules/.bin into PATH; that is exactly where the stub
    // lives, so skip any .bin directory under this repo's node_modules.
    .filter((dir) => !dir.includes(join("node_modules", ".bin")));
  // Prefer a real native bun.exe (no shell needed) over a .cmd/.ps1 shim, which
  // would force spawn's shell:true and trip DEP0190. Scan ALL dirs for the .exe
  // first, then fall back to shims, then to a bare "bun".
  const tiers =
    process.platform === "win32"
      ? [["bun.exe", 100_000], ["bun.cmd", 0], ["bun.bat", 0], ["bun", 0]]
      : [["bun", 0]];
  for (const [name, minSize] of tiers) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        const st = statSync(candidate);
        if (st.isFile() && st.size >= minSize) return candidate;
      } catch {
        // not here, keep looking
      }
    }
  }
  return "bun"; // fall back; will surface a clear error if truly missing
}

const BUN = resolveBun();

/**
 * Map a Rust/Tauri target triple to bun's `--target=bun-<os>-<arch>` flag.
 * Tauri names sidecars by the Rust triple; bun compiles for a bun-<os>-<arch>
 * token. We keep both: bun target drives the compile, the triple names the file.
 */
const TRIPLE_TO_BUN = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-x64", // bun has no win-arm64 target yet
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

/** Resolve the host target triple via `rustc -vV`, the same value Tauri uses. */
function hostTriple() {
  const r = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout) {
    const m = r.stdout.match(/^host:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  // Fallback inference if rustc isn't on PATH.
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const argTriple = process.argv.find((a) => a.startsWith("--target="));
// Resolution order: explicit `--target=` flag wins; else the TERAX_SIDECAR_TARGET
// env var (set so the pnpm `pretauri` hook — which tauri-action runs and we can't
// pass CLI args to — stages the right triple on cross-compile rows); else host.
const triple = argTriple
  ? argTriple.slice("--target=".length)
  : process.env.TERAX_SIDECAR_TARGET || hostTriple();
const bunTarget = TRIPLE_TO_BUN[triple];
if (!bunTarget) {
  console.error(`Unsupported target triple: ${triple}`);
  console.error(`Known: ${Object.keys(TRIPLE_TO_BUN).join(", ")}`);
  process.exit(1);
}

/**
 * Sidecars to build. `base` is the Tauri externalBin name (no triple, no ext);
 * `entry` is the source the bun bundler compiles.
 */
const TARGETS = [
  {
    base: "bunqueue-server",
    entry: join(ROOT, "node_modules", "bunqueue", "dist", "cli", "index.js"),
  },
  {
    base: "bunqueue-worker-github-create-issue",
    entry: join(ROOT, "src", "modules", "bunqueue", "workers", "githubCreateIssue.ts"),
  },
  {
    base: "bunqueue-worker-http-request",
    entry: join(ROOT, "src", "modules", "bunqueue", "workers", "httpRequest.ts"),
  },
];

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

/**
 * Stage zero-byte placeholders for the Rust-sidecar externalBin entries that
 * the dedicated per-sidecar scripts build LATER in the chain (otel-collector,
 * kv-server, localfs). Why here, before anything else:
 *
 * `terax`'s `tauri-build` build.rs asserts EVERY externalBin entry in
 * tauri.conf.json exists on disk. Any crate that path-depends on `terax_lib`
 * (e.g. `otel-collector`, `kv-server`) triggers that build.rs when compiled.
 * The per-sidecar scripts each stage only their OWN placeholder, so on a clean
 * checkout (binaries/ is gitignored) the FIRST terax-dependent cargo build in
 * the chain fails on the sidecars staged AFTER it — e.g. otel-collector (built
 * 3rd) aborts because kv-server (4th) and localfs (5th) aren't staged yet.
 *
 * `build-sidecars.mjs` runs FIRST in both `build:sidecars` and `pretauri`, and
 * builds bunqueue with the bun bundler (no cargo, no build.rs), so staging all
 * placeholders here guarantees the full externalBin set is present before any
 * cargo build runs — order-independent and robust to future reordering. Each
 * per-sidecar script still overwrites its placeholder with the real binary.
 */
const RUST_SIDECAR_BASES = ["otel-collector", "kv-server", "localfs", "rmux-daemon"];
for (const base of RUST_SIDECAR_BASES) {
  const placeholder = join(OUT_DIR, `${base}-${triple}${EXE}`);
  if (!existsSync(placeholder)) {
    writeFileSync(placeholder, "");
    console.log(`Staged placeholder: ${placeholder}`);
  }
}

// Local-dev mtime cache: skip `bun build --compile` when the output exe is
// already newer than its entry source AND newer than this build script itself
// (a config change here should force a rebuild). bun has no built-in staleness
// check, so this is a make-style guard. CI always rebuilds for reproducible
// release artifacts; --force overrides locally.
const CACHE_DISABLED = Boolean(process.env.CI) || process.argv.includes("--force");
const SELF_MTIME = statSync(fileURLToPath(import.meta.url)).mtimeMs;

/** True when `outfile` is up to date relative to `entry` and this script. */
function isUpToDate(outfile, entry) {
  if (CACHE_DISABLED || !existsSync(outfile)) return false;
  try {
    const out = statSync(outfile).mtimeMs;
    // A zero-byte placeholder (staged above) is never a valid cache hit.
    if (statSync(outfile).size === 0) return false;
    return out >= statSync(entry).mtimeMs && out >= SELF_MTIME;
  } catch {
    return false;
  }
}

console.log(`Building bunqueue sidecars for ${triple} (${bunTarget})`);

for (const { base, entry } of TARGETS) {
  if (!existsSync(entry)) {
    console.error(`Missing entry: ${entry}`);
    process.exit(1);
  }
  const outfile = join(OUT_DIR, `${base}-${triple}${EXE}`);
  if (isUpToDate(outfile, entry)) {
    console.log(`  ${base}  (up to date, skip)`);
    continue;
  }
  console.log(`  ${base}  <-  ${entry}`);
  const r = spawnSync(
    BUN,
    ["build", "--compile", `--target=${bunTarget}`, entry, "--outfile", outfile],
    { stdio: "inherit", cwd: ROOT, shell: /\.(cmd|bat)$/i.test(BUN) },
  );
  if (r.status !== 0) {
    console.error(`bun build failed for ${base} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

console.log(`Done. Sidecars in ${OUT_DIR}`);
