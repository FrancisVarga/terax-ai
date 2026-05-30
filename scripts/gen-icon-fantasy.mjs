// Generate 3 SUPER-FANTASY realistic Terax app-icon variants.
// Via Gemini 3 Pro Image (Nano Banana Pro). Non-destructive: writes to its OWN dir,
// leaves the stylized + photoreal sets untouched.
// Usage: node scripts/gen-icon-fantasy.mjs
// Reads GEMINI_API_KEY from .env (never logged).

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

// Same composition, super-fantasy wording.
const SUBJECT = [
  "A magnificent vertical longsword standing upright dead-center in the FOREGROUND, the blade forged",
  "from intensely SUPER GOLDEN molten 24-karat gold — mirror-polished, blazing with razor-sharp",
  "specular highlights and faint glowing arcane runes etched along the fuller; it is the brightest,",
  "most prominent, tack-sharp hero element, lit from the front so it pops dramatically. BEHIND it",
  "towers a colossal ancient Elden world-tree as a DARK silhouette — massive gnarled near-black bark",
  "with faint bioluminescent golden sap glimmering in the cracks, deep shadowed canopy receding in",
  "atmospheric soft focus. At the base, hyper-detailed real green and black olives with dew on the",
  "olive leaves. Strong contrast between the radiant golden sword and the dark tree.",
  "Square 1:1 app icon, centered, fills the frame, no text, no watermark.",
].join(" ");

// Realism anchors kept; flavor pushed toward magic/epic concept art.
const FANTASY = [
  "Super-fantasy realism, epic high-fantasy concept art, Unreal Engine 5 + Octane ray-traced render,",
  "physically-based materials, volumetric god-rays, drifting embers and magical dust motes, 8K, ultra",
  "sharp, dramatic chiaroscuro lighting, immense mythic scale.",
].join(" ");

const VARIANTS = [
  {
    name: "fantasy-1-sacred-grove.png",
    prompt: `${SUBJECT} ${FANTASY} Mood: a sacred moonlit grove, shafts of cold blue moonlight cutting through the dark canopy while the golden sword radiates warm light, floating glowing pollen, ethereal and reverent.`,
  },
  {
    name: "fantasy-2-emberfall.png",
    prompt: `${SUBJECT} ${FANTASY} Mood: a smoldering twilight battlefield aftermath, swirling orange embers and ash rising around the blade, the dark tree backlit by a dim ember-red glow, heroic and ominous.`,
  },
  {
    name: "fantasy-3-arcane-bloom.png",
    prompt: `${SUBJECT} ${FANTASY} Mood: the world-tree in magical golden bloom, streams of glowing golden energy spiraling up the trunk and feeding into the sword, luminous magic particles, awe-inspiring and divine.`,
  },
];

// Trust the API mimeType so on-disk bytes always match the extension.
const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

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
  const mime = img.inlineData.mimeType ?? "image/png";
  const ext = EXT_BY_MIME[mime] ?? "png";
  return { buf: Buffer.from(img.inlineData.data, "base64"), ext };
}

const outDir = resolve(ROOT, "src-tauri/icon-variants/fantasy");
mkdirSync(outDir, { recursive: true });

for (const v of VARIANTS) {
  process.stdout.write(`Generating ${v.name} ... `);
  try {
    const { buf, ext } = await generate(v.prompt);
    const name = v.name.replace(/\.[^.]+$/, `.${ext}`);
    writeFileSync(resolve(outDir, name), buf);
    console.log(`ok (${(buf.length / 1024).toFixed(1)} KB) -> ${name}`);
  } catch (e) {
    console.log("FAILED");
    console.error(`  ${e.message}`);
    process.exitCode = 1;
  }
}
