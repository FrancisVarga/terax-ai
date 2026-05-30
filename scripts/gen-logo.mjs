// Generate Terax app logo / icon / thumbnails via Gemini 3 Pro Image (Nano Banana Pro).
// Usage: node scripts/gen-logo.mjs
// Reads GEMINI_API_KEY from .env (never logged).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- load GEMINI_API_KEY from .env (no dotenv dep) ---
function loadKey() {
  const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  throw new Error("GEMINI_API_KEY not found in .env");
}

const API_KEY = loadKey();
const MODEL = "gemini-3-pro-image-preview"; // Nano Banana Pro
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Core art direction shared across every asset.
const SUBJECT = [
  "A majestic vertical sword standing upright in the center, the blade made of",
  "intensely SUPER GOLDEN polished metal — radiant, shimmering, glowing gold with",
  "bright specular highlights and warm reflections, the most golden element of the image.",
  "Behind the sword rises a luminous ancient Elden tree / world-tree with sprawling",
  "glowing branches and golden foliage. At the bottom, a cluster of green and black",
  "olives with olive branches and leaves framing the base of the sword.",
  "Heroic, mythic, premium game-logo aesthetic. Clean dark background, dramatic rim light,",
  "high contrast, crisp edges, centered composition.",
].join(" ");

const ASSETS = [
  {
    name: "terax-logo-master.png",
    out: "src-tauri/terax-logo-master.png",
    prompt: `App icon, perfectly square 1:1. ${SUBJECT} Deep near-black radial-gradient background so the golden sword pops. No text, no letters, no watermark. Icon-ready, subject fills most of the frame with slight padding.`,
  },
  {
    name: "logo.png",
    out: "public/logo.png",
    prompt: `Square app logo, 1:1. ${SUBJECT} Transparent-feeling dark background, polished app-store quality. No text.`,
  },
  {
    name: "thumbnail-wide.png",
    out: "public/thumbnail-wide.png",
    prompt: `Wide 16:9 marketing banner thumbnail. ${SUBJECT} The golden sword off-center-left, Elden tree filling the right, olives along the lower edge. Cinematic, room for nothing else. The word "TERAX" in elegant engraved golden serif capitals, small, lower-right corner.`,
  },
  {
    name: "thumbnail-square.png",
    out: "public/thumbnail-square.png",
    prompt: `Square 1:1 social thumbnail. ${SUBJECT} Bold, poster-like, the word "TERAX" in golden engraved serif capitals centered at the bottom above the olives.`,
  },
];

async function generate(prompt) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) {
    throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return Buffer.from(img.inlineData.data, "base64");
}

for (const a of ASSETS) {
  process.stdout.write(`Generating ${a.name} ... `);
  try {
    const buf = await generate(a.prompt);
    const dest = resolve(ROOT, a.out);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.log(`ok (${(buf.length / 1024).toFixed(1)} KB) -> ${a.out}`);
  } catch (e) {
    console.log("FAILED");
    console.error(`  ${e.message}`);
    process.exitCode = 1;
  }
}
