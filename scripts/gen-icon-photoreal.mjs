// Generate 3 PHOTOREALISTIC / super-fantasy-realistic Terax app-icon variants.
// Via Gemini 3 Pro Image (Nano Banana Pro). Non-destructive: writes to a NEW dir,
// leaves the existing stylized icon-variants/*.png untouched.
// Usage: node scripts/gen-icon-photoreal.mjs
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

// Shared subject — same composition as the stylized set, but realism-focused wording.
const SUBJECT = [
  "A majestic vertical longsword standing upright dead-center in the FOREGROUND. The blade is",
  "forged from intensely SUPER GOLDEN polished metal — radiant 24-karat gold with razor-sharp",
  "specular highlights, warm reflections and a subtle glow; it is the brightest, most prominent,",
  "tack-sharp element, lit from the front and popping off the background. BEHIND it, much darker,",
  "stands an ancient gnarled Elden world-tree as a DARK silhouette — deep brown, near-black bark,",
  "dim shadowed foliage, receding in soft focus so it never competes with the blade. At the base,",
  "a cluster of real green and black olives on olive branches with detailed leaves. Strong contrast",
  "between the bright golden sword and the dark tree. Square 1:1 app icon, centered, fills the frame,",
  "no text, no watermark.",
].join(" ");

const PHOTOREAL = [
  "Photorealistic, hyper-detailed, shot on a full-frame DSLR with an 85mm lens, macro product",
  "photography, shallow depth of field, volumetric studio lighting, ray-traced reflections,",
  "physically-based materials, 8K, ultra sharp, cinematic color grading, realistic metal and bark",
  "textures.",
].join(" ");

const VARIANTS = [
  {
    name: "photoreal-1-studio.png",
    prompt: `${SUBJECT} ${PHOTOREAL} Mood: clean dark studio backdrop, dramatic single key light raking across the polished golden blade, glossy premium product shot.`,
  },
  {
    name: "photoreal-2-cinematic.png",
    prompt: `${SUBJECT} ${PHOTOREAL} Mood: epic super-fantasy cinematic scene, the dark world-tree wreathed in faint mist and floating embers, god-rays behind the glowing golden sword, moody atmospheric depth, Unreal Engine 5 cinematic, AAA fantasy key art.`,
  },
  {
    name: "photoreal-3-forged.png",
    prompt: `${SUBJECT} ${PHOTOREAL} Mood: the golden sword planted in dark mossy earth at the foot of the ancient tree, dew on the olive leaves, soft dawn rim-light, weathered realistic gold with fine engraving, naturalistic high-fantasy realism.`,
  },
];

// Map the API-reported mimeType to a file extension so we never write
// JPEG bytes into a .png-named file (Gemini image preview returns image/jpeg).
const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

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

const outDir = resolve(ROOT, "src-tauri/icon-variants/photoreal");
mkdirSync(outDir, { recursive: true });

for (const v of VARIANTS) {
  process.stdout.write(`Generating ${v.name} ... `);
  try {
    const { buf, ext } = await generate(v.prompt);
    // Trust the API mimeType over the declared name: rewrite the extension so
    // the on-disk file's bytes always match its extension.
    const name = v.name.replace(/\.[^.]+$/, `.${ext}`);
    writeFileSync(resolve(outDir, name), buf);
    console.log(`ok (${(buf.length / 1024).toFixed(1)} KB) -> ${name}`);
  } catch (e) {
    console.log("FAILED");
    console.error(`  ${e.message}`);
    process.exitCode = 1;
  }
}
