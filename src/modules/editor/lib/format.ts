import type { Options as PrettierOptions, Plugin } from "prettier";

/**
 * In-editor "Format Document" engine.
 *
 * Prettier runs entirely in the browser via `prettier/standalone`. The browser
 * build has no filesystem, so it never discovers a `.prettierrc` — every option
 * is passed explicitly here and the indent width is seeded to match the editor's
 * 2-space `indentUnit` (see `lib/extensions.ts`).
 *
 * Plugins are dynamically imported per language so opening a `.css` file never
 * pulls in the (874 KB) TypeScript plugin. This mirrors the lazy-import
 * discipline in `lib/languageResolver.ts`.
 */

type PluginLoader = () => Promise<Plugin>;

// estree is the shared AST *printer* for the JS/TS family; babel/typescript are
// the *parsers*. Prettier v3 requires both halves to be registered together.
const estree: PluginLoader = () =>
  import("prettier/plugins/estree").then((m) => m.default as Plugin);
const babel: PluginLoader = () =>
  import("prettier/plugins/babel").then((m) => m.default as Plugin);
const typescript: PluginLoader = () =>
  import("prettier/plugins/typescript").then((m) => m.default as Plugin);
const postcss: PluginLoader = () =>
  import("prettier/plugins/postcss").then((m) => m.default as Plugin);
const html: PluginLoader = () =>
  import("prettier/plugins/html").then((m) => m.default as Plugin);
const markdown: PluginLoader = () =>
  import("prettier/plugins/markdown").then((m) => m.default as Plugin);
const yaml: PluginLoader = () =>
  import("prettier/plugins/yaml").then((m) => m.default as Plugin);
const graphql: PluginLoader = () =>
  import("prettier/plugins/graphql").then((m) => m.default as Plugin);

export type PrettierSpec = {
  /** Prettier parser name (the `parser` option). */
  parser: string;
  /** Plugin loaders required for this parser. */
  plugins: PluginLoader[];
};

// Extension → Prettier parser + plugin set. Only extensions listed here get a
// real pretty-print; everything else falls back to CodeMirror reindent (see
// EditorPane.format).
const PRETTIER_BY_EXT: Record<string, PrettierSpec> = {
  js: { parser: "babel", plugins: [babel, estree] },
  jsx: { parser: "babel", plugins: [babel, estree] },
  mjs: { parser: "babel", plugins: [babel, estree] },
  cjs: { parser: "babel", plugins: [babel, estree] },
  ts: { parser: "typescript", plugins: [typescript, estree] },
  tsx: { parser: "typescript", plugins: [typescript, estree] },
  mts: { parser: "typescript", plugins: [typescript, estree] },
  cts: { parser: "typescript", plugins: [typescript, estree] },

  json: { parser: "json", plugins: [babel, estree] },
  jsonc: { parser: "json", plugins: [babel, estree] },
  json5: { parser: "json5", plugins: [babel, estree] },

  css: { parser: "css", plugins: [postcss] },
  scss: { parser: "scss", plugins: [postcss] },
  less: { parser: "less", plugins: [postcss] },

  html: { parser: "html", plugins: [html] },
  htm: { parser: "html", plugins: [html] },
  vue: { parser: "vue", plugins: [html] },

  md: { parser: "markdown", plugins: [markdown] },
  markdown: { parser: "markdown", plugins: [markdown] },
  mdx: { parser: "mdx", plugins: [markdown] },

  yaml: { parser: "yaml", plugins: [yaml] },
  yml: { parser: "yaml", plugins: [yaml] },

  graphql: { parser: "graphql", plugins: [graphql] },
  gql: { parser: "graphql", plugins: [graphql] },
};

function extOf(path: string): string | null {
  const base = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

/** Look up the Prettier spec for a path, or null if unsupported. */
export function prettierSpecFor(path: string): PrettierSpec | null {
  const ext = extOf(path);
  return (ext ? PRETTIER_BY_EXT[ext] : undefined) ?? null;
}

/** True when `path` has a Prettier-backed formatter (used to gate the UI). */
export function canPrettierFormat(path: string): boolean {
  return prettierSpecFor(path) != null;
}

/**
 * Run Prettier for a resolved spec. Shared by the main-thread path and the Web
 * Worker — keep it free of DOM/window references so it runs in both contexts.
 *
 * Throws if Prettier itself fails (e.g. a syntax error in the source).
 */
export async function runPrettier(
  spec: PrettierSpec,
  source: string,
): Promise<string> {
  const [{ format }, ...plugins] = await Promise.all([
    import("prettier/standalone"),
    ...spec.plugins.map((load) => load()),
  ]);

  const options: PrettierOptions = {
    parser: spec.parser,
    plugins,
    // Match the editor's 2-space indent (lib/extensions.ts indentUnit).
    tabWidth: 2,
    useTabs: false,
  };

  return format(source, options);
}

/**
 * Format `source` with Prettier if the file extension is supported, else
 * return `null` to signal the caller should fall back to CodeMirror reindent.
 *
 * Throws if Prettier itself fails (e.g. a syntax error in the source) — the
 * caller surfaces this rather than silently leaving the buffer unchanged.
 *
 * NOTE: runs Prettier on the calling thread. For potentially large documents,
 * prefer `formatWithPrettierAsync` which offloads big files to a Web Worker so
 * the parse/print never blocks the UI.
 */
export async function formatWithPrettier(
  path: string,
  source: string,
): Promise<string | null> {
  const spec = prettierSpecFor(path);
  if (!spec) return null;
  return runPrettier(spec, source);
}
