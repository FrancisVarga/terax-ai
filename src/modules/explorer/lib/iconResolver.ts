import materialIcons from "@iconify-json/material-icon-theme/icons.json";
import { EXT_TO_LANGUAGE_ID } from "./constants";
import * as fileIconsMod from "./fileIcons";
import * as folderIconsMod from "./folderIcons";

const catFileNames = fileIconsMod.fileNames as Record<string, string>;
const catFileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const catLanguageIds = fileIconsMod.languageIds as Record<string, string>;
const catFolderNames = folderIconsMod.folderNames as Record<string, string>;

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

// Material Icon Theme. The association manifest (fileIcons/folderIcons) already
// uses material-icon-theme slugs, so names resolve directly against this set.
// Material icons are authored on a 24x24 grid (catppuccin used 16x16) and use
// different default slugs: `document` / `folder-base` instead of `file` /
// `folder`.
const cat = materialIcons as unknown as IconifySet;
const CAT_W = cat.width ?? 24;
const CAT_H = cat.height ?? 24;

const DEFAULT_FILE = "document";
const DEFAULT_FOLDER = "folder-base";
const DEFAULT_FOLDER_OPEN = "folder-base-open";

const dataUrlCache = new Map<string, string>();

// The association manifest uses material-icon-theme's source definition IDs;
// the iconify export keys a few icons under a different output slug. Bridge the
// divergent names here. Extend when another mismatch surfaces.
const SLUG_ALIASES: Record<string, string> = {
  // file-icon slug renames
  "adobe-ai": "adobe-illustrator",
  "adobe-ps": "adobe-photoshop",
  apple: "applescript",
  "circle-ci": "circleci",
  coffeescript: "coffee",
  "java-jar": "jar",
  "javascript-react": "react",
  "markdown-mdx": "mdx",
  "ms-powerpoint": "powerpoint",
  "ms-word": "word",
  prototools: "proto",
  tailwind: "tailwindcss",
  turbo: "turborepo",
  "typescript-react": "react-ts",
  "web-assembly": "webassembly",
  windi: "windicss",
  // folder-icon slug renames (resolver appends -open for expanded)
  "folder-azure-devops": "folder-azure-pipelines",
  "folder-cargo": "folder-rust",
  "folder-circle-ci": "folder-circleci",
  "folder-cloud": "folder-cloud-functions",
  "folder-controllers": "folder-controller",
  "folder-devcontainer": "folder-container",
  "folder-direnv": "folder-environment",
  "folder-drizzle-orm": "folder-drizzle",
  "folder-fonts": "folder-font",
  "folder-fvm": "folder-flutter",
  "folder-hooks": "folder-hook",
  "folder-layouts": "folder-layout",
  "folder-locales": "folder-i18n",
  "folder-mocks": "folder-mock",
  "folder-moonrepo": "folder-moon",
  "folder-plugins": "folder-plugin",
  "folder-roblox": "folder-luau",
  "folder-security": "folder-secure",
  "folder-tauri": "folder-src-tauri",
  "folder-templates": "folder-template",
  "folder-tests": "folder-test",
  "folder-themes": "folder-theme",
  "folder-turbo": "folder-turborepo",
  "folder-types": "folder-typescript",
  "folder-workflows": "folder-gh-workflows",
  "folder-xcode": "folder-ios",
};

// The manifest emits names like `folder_src`/`typescript-react`, but the
// iconify export normalizes everything to hyphenated slugs.
function toIconifySlug(name: string): string {
  const hyphenated = name.replace(/_/g, "-");
  return SLUG_ALIASES[hyphenated] ?? hyphenated;
}

function catBody(iconName: string): string | null {
  const slug = toIconifySlug(iconName);
  const direct = cat.icons[slug];
  if (direct) return direct.body;
  const alias = cat.aliases?.[slug];
  if (alias) {
    const parent = cat.icons[alias.parent];
    if (parent) return parent.body;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const body = catBody(iconName);
  if (!body) {
    dataUrlCache.set(iconName, "");
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CAT_W} ${CAT_H}">${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = catFileNames[lower];
  if (byName) {
    const url = buildDataUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = catFileExtensions[ext];
    if (iconName) {
      const url = buildDataUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = catLanguageIds[langId];
      if (iconByLang) {
        const url = buildDataUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();

  const mapped = catFolderNames[lower];
  if (mapped) {
    const slug = toIconifySlug(mapped);
    const target = expanded ? `${slug}-open` : slug;
    const url = buildDataUrl(target);
    if (url) return url;
  }

  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
