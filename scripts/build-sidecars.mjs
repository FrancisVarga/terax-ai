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
import { existsSync, mkdirSync, statSync } from "node:fs";
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
const triple = argTriple ? argTriple.slice("--target=".length) : hostTriple();
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

console.log(`Building bunqueue sidecars for ${triple} (${bunTarget})`);

for (const { base, entry } of TARGETS) {
  if (!existsSync(entry)) {
    console.error(`Missing entry: ${entry}`);
    process.exit(1);
  }
  const outfile = join(OUT_DIR, `${base}-${triple}${EXE}`);
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
