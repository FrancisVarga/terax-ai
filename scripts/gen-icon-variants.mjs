// Generate 3 Terax app-icon variants to choose from, via Gemini 3 Pro Image (Nano Banana Pro).
// Usage: node scripts/gen-icon-variants.mjs
// Reads GEMINI_API_KEY from .env (never logged). Saves to src-tauri/icon-variants/.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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

// Shared subject — held constant so variants differ only in art style.
const SUBJECT = [
  "A majestic vertical sword standing upright dead-center in the FOREGROUND, the blade made of",
  "intensely SUPER GOLDEN polished metal — radiant, shimmering, brightly glowing gold with strong",
  "specular highlights. The sword is the brightest, most prominent, clearly-visible element, lit",
  "from the front and popping sharply off the background. BEHIND it, much darker, sits an ancient",
  "Elden world-tree rendered as a DARK shadowy silhouette — deep brown / near-black branches and",
  "dim foliage, dimly backlit, clearly receding behind the sword so it never competes with or",
  "obscures the blade. At the bottom, a cluster of dark green and black olives with olive branches",
  "framing the base. Strong contrast between the bright golden sword and the dark tree behind it.",
  "Square 1:1 app icon, centered, subject fills most of the frame, no text, no watermark.",
].join(" ");

const VARIANTS = [
  {
    name: "variant-1-painterly.png",
    prompt: `${SUBJECT} Style: rich painterly fantasy game-icon, deep charcoal radial-gradient background, dramatic rim light only on the golden sword, the tree kept in shadow, high contrast, glossy app-store finish.`,
  },
  {
    name: "variant-2-emblem-flat.png",
    prompt: `${SUBJECT} Style: clean modern flat emblem / heraldic crest, the SWORD in bold bright gold, the TREE in dark muted bronze/charcoal so it reads as background, deep navy-to-black gradient, crisp vector-like edges, premium minimalist app icon.`,
  },
  {
    name: "variant-3-engraved-3d.png",
    prompt: `${SUBJECT} Style: ornate engraved metal medallion, the golden sword raised in bright high-relief, the tree etched darker and recessed into forged near-black iron, intricate filigree border, luxurious cinematic lighting, AAA game emblem.`,
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error(`No image: ${JSON.stringify(json).slice(0, 400)}`);
  return Buffer.from(img.inlineData.data, "base64");
}

const outDir = resolve(ROOT, "src-tauri/icon-variants");
mkdirSync(outDir, { recursive: true });

for (const v of VARIANTS) {
  process.stdout.write(`Generating ${v.name} ... `);
  try {
    const buf = await generate(v.prompt);
    writeFileSync(resolve(outDir, v.name), buf);
    console.log(`ok (${(buf.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.log("FAILED");
    console.error(`  ${e.message}`);
    process.exitCode = 1;
  }
}
