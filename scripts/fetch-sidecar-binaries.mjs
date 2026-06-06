/**
 * Download prebuilt CLI release binaries and stage them as Tauri sidecars under
 * `src-tauri/binaries/`.
 *
 * Why: Terax shells out to a few external CLIs (`rg` for search, `s5cmd` for
 * fast S3 transfers). A packaged build has no system install of these
 * guaranteed, so we ship them as externalBin sidecars — the same mechanism used
 * for the bunqueue sidecars (see build-sidecars.mjs). Unlike bunqueue (compiled
 * from source via `bun build --compile`), these are fetched as official
 * prebuilt releases from GitHub.
 *
 * Tauri's `externalBin` requires each sidecar be suffixed with the Rust target
 * triple (e.g. `-x86_64-pc-windows-msvc`); the bundler strips it at install and
 * the app resolves the bare name next to its own executable.
 *
 * Each release project names its assets differently (ripgrep uses Rust triples
 * + bare-semver tags; s5cmd uses friendly OS/arch tokens + a `v`-prefixed tag),
 * so every tool owns its `tag`/`asset` mapping in the TOOLS registry below.
 *
 * Run via: `pnpm fetch:sidecars` — fetches all tools for the host triple.
 *   --all                stage every supported triple (release/CI builds)
 *   --target=<triple>    stage one specific triple
 *   --tool=<name>        limit to one tool (rg | s5cmd); repeatable
 *   --force              re-download even if the staged version already matches
 *
 * Local-dev cache: each staged sidecar gets a sibling `<file>.version` marker
 * recording the upstream version it was built from. On a subsequent local run we
 * still ask GitHub for the latest version (cheap JSON GET), but if the marker
 * already matches we skip the multi-MB download + extract + copy. The marker is
 * the cache key, so an upstream version bump invalidates it automatically. CI
 * (process.env.CI set) always fetches fresh for reproducible release artifacts;
 * `--force` overrides the cache locally.
 */

import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "src-tauri", "binaries");
/**
 * Request headers for GitHub. Unauthenticated calls share a 60 req/hr/IP budget
 * — on hosted CI that pool is drained by other jobs on the same runner IP,
 * surfacing as a 403 on `releases/latest`. When a token is present (CI sets
 * `GITHUB_TOKEN`; local `gh` sets `GH_TOKEN`) we send it to lift the cap to
 * 5000 req/hr. A bad token returns 401, not 403, so the unauthenticated
 * fallback stays correct.
 */
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const UA = {
  "User-Agent": "terax-fetch-sidecar-binaries",
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

/** Every triple we may stage, keyed for per-tool asset lookups. */
const TRIPLES = [
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
];

/**
 * Tool registry. Each entry:
 *   repo      GitHub owner/name (for the latest-release lookup + download URL)
 *   base      sidecar name registered in tauri.conf.json externalBin (bare)
 *   binName   the executable name inside the archive (without .exe)
 *   tag       (version) => the git tag for that version
 *   asset     (triple, version) => { name, kind } | null  (null = unsupported)
 *               kind: "zip" | "tar"
 */
const TOOLS = {
  rg: {
    repo: "BurntSushi/ripgrep",
    base: "rg",
    binName: "rg",
    tag: (v) => v, // ripgrep tags are bare semver (e.g. "15.1.0")
    asset: (triple, v) => {
      // Linux uses the static musl build (no glibc version dependency).
      const map = {
        "x86_64-pc-windows-msvc": ["x86_64-pc-windows-msvc", "zip"],
        "aarch64-pc-windows-msvc": ["x86_64-pc-windows-msvc", "zip"], // no win-arm64 build
        "x86_64-apple-darwin": ["x86_64-apple-darwin", "tar"],
        "aarch64-apple-darwin": ["aarch64-apple-darwin", "tar"],
        "x86_64-unknown-linux-gnu": ["x86_64-unknown-linux-musl", "tar"],
        "aarch64-unknown-linux-gnu": ["aarch64-unknown-linux-gnu", "tar"],
      };
      const hit = map[triple];
      if (!hit) return null;
      const [suffix, kind] = hit;
      const ext = kind === "zip" ? "zip" : "tar.gz";
      return { name: `ripgrep-${v}-${suffix}.${ext}`, kind };
    },
  },
  s5cmd: {
    repo: "peak/s5cmd",
    base: "s5cmd",
    binName: "s5cmd",
    tag: (v) => `v${v}`, // s5cmd tags are v-prefixed (e.g. "v2.3.0")
    asset: (triple, v) => {
      // s5cmd asset token: <OS>-<arch>. Note version in the name has NO 'v'.
      const map = {
        "x86_64-pc-windows-msvc": ["Windows-64bit", "zip"],
        "aarch64-pc-windows-msvc": ["Windows-arm64", "zip"], // native win-arm64 build exists
        "x86_64-apple-darwin": ["macOS-64bit", "tar"],
        "aarch64-apple-darwin": ["macOS-arm64", "tar"],
        "x86_64-unknown-linux-gnu": ["Linux-64bit", "tar"],
        "aarch64-unknown-linux-gnu": ["Linux-arm64", "tar"],
      };
      const hit = map[triple];
      if (!hit) return null;
      const [suffix, kind] = hit;
      const ext = kind === "zip" ? "zip" : "tar.gz";
      return { name: `s5cmd_${v}_${suffix}.${ext}`, kind };
    },
  },
};

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

/** Latest published version for a repo, with the tag's leading `v` stripped. */
async function latestVersion(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: UA,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} fetching ${repo} latest`);
  const json = await res.json();
  return json.tag_name.replace(/^v/, "");
}

async function download(url, dest) {
  const res = await fetch(url, { headers: UA, redirect: "follow" });
  if (!res.ok) throw new Error(`Download ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/** Extract an archive into `dir` — Expand-Archive for zip, `tar` for tgz. */
function extract(archive, dir, kind) {
  if (kind === "zip") {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${dir}' -Force`],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error(`Expand-Archive failed (exit ${r.status})`);
  } else {
    const r = spawnSync("tar", ["-xzf", archive, "-C", dir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar extract failed (exit ${r.status})`);
  }
}

/** Recursively find the first file named `bin` or `bin.exe` under `dir`. */
async function findBinary(dir, bin) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findBinary(full, bin);
      if (hit) return hit;
    } else if (e.name === bin || e.name === `${bin}.exe`) {
      return full;
    }
  }
  return null;
}

/**
 * True when a previously-staged sidecar already matches `version`, so the
 * download can be skipped. Requires BOTH the binary and its `.version` marker to
 * exist and the marker to record the same version. Disabled in CI and under
 * --force so release builds and explicit re-fetches always pull fresh.
 */
function isCached(outfile, version) {
  if (CACHE_DISABLED) return false;
  const marker = `${outfile}.version`;
  if (!existsSync(outfile) || !existsSync(marker)) return false;
  try {
    return readFileSync(marker, "utf8").trim() === version;
  } catch {
    return false;
  }
}

async function stage(tool, triple, version) {
  const spec = tool.asset(triple, version);
  if (!spec) {
    console.error(`  ${tool.base}: no asset for ${triple} — skipping`);
    return;
  }
  const isWin = triple.includes("windows");
  const exe = isWin ? ".exe" : "";
  const outfile = join(OUT_DIR, `${tool.base}-${triple}${exe}`);
  const url = `https://github.com/${tool.repo}/releases/download/${tool.tag(version)}/${spec.name}`;

  if (isCached(outfile, version)) {
    console.log(`  ${tool.base} ${triple}  (cached ${version}, skip)`);
    return;
  }

  console.log(`  ${tool.base} ${triple}  <-  ${spec.name}`);
  const work = await mkdtemp(join(tmpdir(), `${tool.base}-fetch-`));
  try {
    const archive = join(work, spec.name);
    await download(url, archive);
    extract(archive, work, spec.kind);
    const bin = await findBinary(work, tool.binName);
    if (!bin) throw new Error(`${tool.binName} not found inside ${spec.name}`);
    await copyFile(bin, outfile);
    if (!isWin) await chmod(outfile, 0o755); // release archives keep the bit, but be explicit
    // Record the version as the local-dev cache key for the next run.
    writeFileSync(`${outfile}.version`, version);
    console.log(`    -> ${outfile}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const all = args.includes("--all");
// Local-dev cache is off in CI (reproducible release artifacts) and under
// --force (explicit re-fetch). Marker files only consulted when this is false.
const CACHE_DISABLED = Boolean(process.env.CI) || args.includes("--force");
const argTriple = args.find((a) => a.startsWith("--target="));
const wantedTools = args
  .filter((a) => a.startsWith("--tool="))
  .map((a) => a.slice("--tool=".length));

// Single-triple resolution order: explicit `--target=` flag wins (the
// `build:sidecars` chain and the CI step both pass it); else the
// TERAX_SIDECAR_TARGET env var (fallback for arg-less cross-compile runs); else
// host. `--all` overrides everything.
const singleTriple = argTriple
  ? argTriple.slice("--target=".length)
  : process.env.TERAX_SIDECAR_TARGET || hostTriple();
const triples = all ? TRIPLES : [singleTriple];
const toolNames = wantedTools.length ? wantedTools : Object.keys(TOOLS);

for (const name of toolNames) {
  if (!TOOLS[name]) {
    console.error(`Unknown tool: ${name}. Known: ${Object.keys(TOOLS).join(", ")}`);
    process.exit(1);
  }
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

for (const name of toolNames) {
  const tool = TOOLS[name];
  const version = await latestVersion(tool.repo);
  console.log(`Fetching ${name} ${version} for: ${triples.join(", ")}`);
  for (const triple of triples) {
    await stage(tool, triple, version);
  }
}
console.log(`Done. Sidecars in ${OUT_DIR}`);
