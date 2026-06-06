import type { Extension } from "@codemirror/state";

type LoaderResult = Extension | { token: unknown };
type LanguageLoader = () => Promise<LoaderResult>;

/** Comment delimiters CodeMirror's `toggleComment` reads from language data. */
type CommentTokens = {
  line?: string;
  block?: { open: string; close: string };
};

const rubyLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby);

const jsonLoader: LanguageLoader = () =>
  import("@codemirror/lang-json").then((m) => m.json());

// `.env` files are KEY=value with `#` comments — the INI/properties stream
// mode highlights keys, separators, values, and comments cleanly.
const envLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties);

const sqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL);
const pgsqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.pgSQL);
const mysqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.mySQL);
const sqliteLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.sqlite);
const mariadbLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.mariaDB);
const mssqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.msSQL);
const plsqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.plSQL);

// PowerShell ships a legacy mode with `#` / `<# #>` comment tokens baked in.
const powershellLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell);

const propertiesLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties);

// Windows batch has no legacy mode in @codemirror/legacy-modes. This minimal
// StreamParser highlights REM/:: comments, @-prefixed lines, %VARS%, labels and
// strings — enough for readable .bat/.cmd files. It declares languageData so
// Ctrl+/ toggles `REM ` line comments.
const batchParser = {
  startState: () => ({}),
  token(stream: {
    sol: () => boolean;
    eatSpace: () => boolean;
    match: (re: RegExp | string, consume?: boolean) => unknown;
    next: () => string | void;
    skipToEnd: () => void;
  }): string | null {
    if (stream.eatSpace()) return null;
    if (stream.sol() && stream.match(/^\s*(?:rem\b|::)/i)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^@/)) return "operator";
    if (stream.match(/^:[A-Za-z0-9_]+/)) return "labelName"; // :label
    if (stream.match(/^%[^%\r\n]*%/)) return "variableName"; // %VAR%
    if (stream.match(/^%%?~?[A-Za-z0-9]/)) return "variableName"; // %%i / %~dp0
    if (stream.match(/^"(?:[^"\r\n])*"?/)) return "string";
    if (
      stream.match(
        /^\b(?:if|else|for|in|do|goto|call|set|echo|exit|setlocal|endlocal|pause|cd|copy|del|move|md|rd|start|shift|not|exist|defined|errorlevel)\b/i,
      )
    ) {
      return "keyword";
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "REM " } },
};
const batchLoader: LanguageLoader = () => Promise.resolve(batchParser);

const iniLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties);

// Nix has no legacy mode in @codemirror/legacy-modes and no @codemirror/lang-nix
// pack ships in this repo, so this minimal StreamParser highlights the language's
// core surface: `#` and `/* */` comments, the `let in rec inherit with …` keyword
// set, `"..."` and `''...''` (multiline) strings with `${…}` antiquotation, paths
// (`./x`, `/x`, `~/x`, `<nixpkgs>`), numbers, and attribute keys before `=`/`?`.
// State carries the open string/comment kind across lines for multiline tokens.
type NixState = {
  // null = code; "dq" = inside "..."; "ind" = inside ''...''; "block" = /* */
  mode: null | "dq" | "ind" | "block";
};

const NIX_KEYWORDS =
  /^(?:let|in|rec|inherit|with|assert|if|then|else|or|import)\b/;
const NIX_ATOMS = /^(?:true|false|null)\b/;

type NixStream = {
  eatSpace: () => boolean;
  peek: () => string | void;
  match: (re: RegExp | string, consume?: boolean) => unknown;
  next: () => string | void;
  skipToEnd: () => void;
};

// Scanner kept separate from the parser literal so the multiline modes
// ("block", "dq", "ind") re-enter it cleanly at the start of each new line.
function nixScan(stream: NixStream, state: NixState): string | null {
  // Inside a block comment: consume until */ (may span more lines).
  if (state.mode === "block") {
    if (stream.match(/^.*?\*\//)) state.mode = null;
    else stream.skipToEnd();
    return "comment";
  }
  // Inside a double-quoted string: scan to the closing `"`, honoring `\`
  // escapes. `${…}` antiquotation is kept inside the string token (not
  // re-highlighted as code) — simpler and avoids zero-width token hangs.
  if (state.mode === "dq") {
    while (stream.peek() != null) {
      if (stream.match(/^\\./)) continue; // escape
      if (stream.match('"')) {
        state.mode = null;
        return "string";
      }
      stream.next();
    }
    return "string";
  }
  // Inside an indented string ''…'': `''` both escapes and terminates.
  if (state.mode === "ind") {
    while (stream.peek() != null) {
      if (stream.match(/^''(?:\$|'|\\.)/)) continue; // ''$ ''' ''\ escapes
      if (stream.match("''")) {
        state.mode = null;
        return "string";
      }
      stream.next();
    }
    return "string";
  }

  if (stream.eatSpace()) return null;

  // Comments
  if (stream.match(/^#.*/)) return "comment";
  if (stream.match("/*")) {
    state.mode = "block";
    if (stream.match(/^.*?\*\//)) state.mode = null;
    else stream.skipToEnd();
    return "comment";
  }

  // Strings
  if (stream.match('"')) {
    state.mode = "dq";
    return "string";
  }
  if (stream.match("''")) {
    state.mode = "ind";
    return "string";
  }

  // Antiquotation braces — surface them as operators; the body re-scans as code.
  if (stream.match("${")) return "operator";

  // Paths: ./x  ../x  /abs/x  ~/x  and search paths <nixpkgs>
  if (stream.match(/^<[A-Za-z0-9._\-+/]+>/)) return "string";
  if (stream.match(/^(?:[A-Za-z0-9._\-+]*)?\/[A-Za-z0-9._\-+/]+/)) {
    return "string";
  }

  // Numbers (int + float)
  if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";

  // Keywords / atoms
  if (stream.match(NIX_ATOMS)) return "atom";
  if (stream.match(NIX_KEYWORDS)) return "keyword";

  // `builtins` namespace
  if (stream.match(/^builtins\b/)) return "variableName.standard";

  // Identifiers — flag attribute keys (followed by `=` or `?`) as definitions.
  const id = stream.match(/^[A-Za-z_][A-Za-z0-9_'-]*/) as RegExpMatchArray | null;
  if (id) {
    // Look ahead past spaces for an assignment to mark it as a property name.
    const after = stream.match(/^\s*[=?]/, false);
    return after ? "propertyName" : "variableName";
  }

  // Operators / punctuation
  if (stream.match(/^(?:\|\||&&|==|!=|<=|>=|->|\+\+|\/\/|[-+*/<>=!?.:@])/)) {
    return "operator";
  }
  if (stream.match(/^[{}()[\];,]/)) return null;

  stream.next();
  return null;
}

const nixParser = {
  startState: (): NixState => ({ mode: null }),
  token: nixScan,
  languageData: {
    commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
  },
};

const nixLoader: LanguageLoader = () => Promise.resolve(nixParser);

/**
 * Extension → loader. Each loader is a dynamic import so language packs
 * only enter the bundle when a matching file is opened.
 *
 * Loaders may return either a ready Extension (lang-* packages) or a raw
 * StreamParser (legacy-modes). `resolveLanguage` wraps the latter in
 * StreamLanguage before returning.
 */
const loaders: Record<string, LanguageLoader> = {
  // JavaScript / TypeScript family
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true }),
    ),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ typescript: true }),
    ),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),

  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: jsonLoader,
  jsonc: jsonLoader,
  json5: jsonLoader,
  env: envLoader,

  sql: sqlLoader,
  psql: pgsqlLoader,
  pgsql: pgsqlLoader,
  mysql: mysqlLoader,
  sqlite: sqliteLoader,
  mariadb: mariadbLoader,
  mssql: mssqlLoader,
  plsql: plsqlLoader,

  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),

  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  astro: () =>
    import("@codemirror/lang-html").then((m) =>
      m.html({ selfClosingTags: true }),
    ),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),

  php: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true })),
  rb: rubyLoader,
  rake: rubyLoader,
  gemspec: rubyLoader,
  ru: rubyLoader,

  // C / C++ family
  c: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  h: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  cpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cc: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),

  // Java
  java: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java),

  // C#
  cs: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),

  // Other clike-family languages (all ship // and /* */ comment tokens)
  dart: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),
  kt: () =>
    import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  kts: () =>
    import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  scala: () =>
    import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  sc: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  m: () =>
    import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC),
  mm: () =>
    import("@codemirror/legacy-modes/mode/clike").then(
      (m) => m.objectiveCpp,
    ),

  // Legacy-modes: loaders return the raw StreamParser; wrapped below.
  sh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  bash: () =>
    import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  zsh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),

  // PowerShell
  ps1: powershellLoader,
  psm1: powershellLoader,
  psd1: powershellLoader,

  // Windows batch
  bat: batchLoader,
  cmd: batchLoader,

  // INI / config / dotenv-style key=value with `#` or `;` comments
  ini: iniLoader,
  cfg: iniLoader,
  conf: iniLoader,
  properties: propertiesLoader,
  editorconfig: propertiesLoader,
  gitconfig: propertiesLoader,

  // Nix (hand-rolled StreamParser above; no upstream pack/legacy mode)
  nix: nixLoader,

  // Misc legacy modes
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),
  pl: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  pm: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  r: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r),
  swift: () =>
    import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),
  cmake: () =>
    import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  patch: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  nginx: () =>
    import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx),
  vb: () => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb),
  vbs: () =>
    import("@codemirror/legacy-modes/mode/vbscript").then((m) => m.vbScript),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  yml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  dockerfile: () =>
    import("@codemirror/legacy-modes/mode/dockerfile").then(
      (m) => m.dockerFile,
    ),

  // LaTeX / TeX
  tex: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  latex: () =>
    import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  sty: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  cls: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
};

const filenameOverrides: Record<string, LanguageLoader> = {
  dockerfile: loaders.dockerfile!,
  "dockerfile.dev": loaders.dockerfile!,
  gemfile: rubyLoader,
  rakefile: rubyLoader,
  podfile: rubyLoader,
  fastfile: rubyLoader,
  guardfile: rubyLoader,
  brewfile: rubyLoader,
  makefile: () =>
    Promise.resolve({
      startState: () => ({}),
      token(stream: { match: (re: RegExp) => unknown; next: () => unknown }) {
        if (stream.match(/^#.*/)) return "comment";
        stream.next();
        return null;
      },
      languageData: { commentTokens: { line: "#" } },
    }),
};

/**
 * Comment tokens by extension, used in two places:
 *  1. Injected into a StreamLanguage when its legacy mode declares no
 *     `languageData.commentTokens` (e.g. properties/INI), so Ctrl+/ works.
 *  2. The generic fallback for files with no registered mode picks a default
 *     here (keyed by extension) so Ctrl+/ still toggles a sensible comment.
 *
 * Modes that already ship correct comment tokens (powershell, shell, yaml,
 * toml, the lang-* packages) are intentionally absent — we never override a
 * mode that knows its own delimiters.
 */
const COMMENT_TOKENS: Record<string, CommentTokens> = {
  // hash-comment config families
  env: { line: "#" },
  ini: { line: "#" },
  cfg: { line: "#" },
  conf: { line: "#" },
  properties: { line: "#" },
  editorconfig: { line: "#" },
  gitconfig: { line: "#" },
  toml: { line: "#" },
  r: { line: "#" },
  cmake: { line: "#" },
  nginx: { line: "#" },
  // C-style
  vbs: { line: "'" },
  vb: { line: "'" },
};

// Default for any text file with no registered mode: `#` is the most common
// line-comment token across config/script files, so Ctrl+/ does something
// useful even on an unknown extension. This is the "all regular files" floor.
const FALLBACK_COMMENT: CommentTokens = { line: "#" };

function extOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

function isStreamParser(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { token?: unknown }).token === "function"
  );
}

const cache = new Map<string, Extension | null>();

// `.env`, `.env.local`, `.env.production`, … all map to one loader regardless
// of the suffix after `.env`.
function isEnvFile(base: string): boolean {
  return base === ".env" || base.startsWith(".env.");
}

// Every filename now resolves to a key — including unknown extensions and
// extension-less files — so the generic fallback language gets cached too.
function cacheKey(filename: string): string {
  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (isEnvFile(base)) return "name:.env";
  if (filenameOverrides[base]) return `name:${base}`;
  const ext = extOf(base);
  return ext ? `ext:${ext}` : "fallback";
}

/**
 * Inject `languageData.commentTokens` into a stream parser when it declares
 * none of its own. CodeMirror's `toggleComment` reads comment delimiters from
 * language data; legacy modes like `properties` ship without them, so Ctrl+/
 * would no-op without this. Modes that already declare commentTokens (e.g.
 * powershell, shell, yaml) are left untouched.
 */
function withCommentTokens(
  parser: Record<string, unknown>,
  tokens: CommentTokens | undefined,
): Record<string, unknown> {
  const existing = (parser as { languageData?: { commentTokens?: unknown } })
    .languageData?.commentTokens;
  if (existing || !tokens) return parser;
  const prev = (parser as { languageData?: object }).languageData ?? {};
  return { ...parser, languageData: { ...prev, commentTokens: tokens } };
}

export function resolveLanguageSync(filename: string): Extension | null {
  return cache.get(cacheKey(filename)) ?? null;
}

export async function resolveLanguage(
  filename: string,
): Promise<Extension | null> {
  const key = cacheKey(filename);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const ext = extOf(base) ?? "";
  const loader = isEnvFile(base)
    ? envLoader
    : (filenameOverrides[base] ?? loaders[ext]);

  const { StreamLanguage } = await import("@codemirror/language");

  // No registered mode → generic fallback: a no-highlight StreamLanguage that
  // still carries comment tokens so Ctrl+/ works on ANY text file. This is the
  // "all regular files" floor.
  if (!loader) {
    const tokens = COMMENT_TOKENS[ext] ?? FALLBACK_COMMENT;
    const fallback = StreamLanguage.define({
      token: (stream) => {
        stream.skipToEnd();
        return null;
      },
      languageData: { commentTokens: tokens },
    });
    cache.set(key, fallback);
    return fallback;
  }

  const result = await loader();
  let extension: Extension;
  if (isStreamParser(result)) {
    extension = StreamLanguage.define(
      withCommentTokens(
        result as Record<string, unknown>,
        COMMENT_TOKENS[ext],
      ) as unknown as Parameters<typeof StreamLanguage.define>[0],
    );
  } else {
    extension = result as Extension;
  }
  cache.set(key, extension);
  return extension;
}

export function preloadLanguages(filenames: string[]): void {
  for (const f of filenames) {
    void resolveLanguage(f).catch(() => {});
  }
}
