// GPU status probe: reports whether the webview is compositing the terminal's
// WebGL surface on real hardware or a software rasterizer (SwiftShader / llvmpipe).
//
// WebGL "working" does not guarantee hardware acceleration — Chromium/WebView2
// ships SwiftShader (a CPU implementation of GL) as a fallback when the GPU is
// blocklisted or unavailable. To the addon it looks identical; to the user it
// is janky. The only reliable signal is the unmasked renderer string exposed
// by WEBGL_debug_renderer_info, which names the actual backend.

export type GpuAcceleration = "hardware" | "software" | "unavailable";

export interface GpuStatus {
  /** Classification used to drive UI ("Hardware accelerated" vs a warning). */
  acceleration: GpuAcceleration;
  /** Raw unmasked renderer string, e.g. "ANGLE (NVIDIA ...)" or "Google SwiftShader". */
  renderer: string | null;
  /** Raw unmasked vendor string, when exposed. */
  vendor: string | null;
}

// Substrings that identify a CPU/software GL backend rather than a real GPU.
const SOFTWARE_MARKERS = [
  "swiftshader",
  "llvmpipe",
  "software",
  "microsoft basic render", // WARP / Windows Basic Render Driver
];

function classify(renderer: string | null): GpuAcceleration {
  if (!renderer) return "unavailable";
  const lower = renderer.toLowerCase();
  return SOFTWARE_MARKERS.some((m) => lower.includes(m))
    ? "software"
    : "hardware";
}

/**
 * Probe the GPU backend by spinning up a throwaway WebGL2 context.
 *
 * Cheap (one off-DOM canvas, immediately discarded) and synchronous. Safe to
 * call from settings UI on demand. Returns "unavailable" if WebGL2 or the
 * debug-renderer extension is missing — never throws.
 */
export function probeGpuStatus(): GpuStatus {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return { acceleration: "unavailable", renderer: null, vendor: null };

    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
      : (gl.getParameter(gl.RENDERER) as string);
    const vendor = dbg
      ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string)
      : (gl.getParameter(gl.VENDOR) as string);

    // Release the context eagerly; don't wait for GC to reclaim the GPU handle.
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    return {
      acceleration: classify(renderer ?? null),
      renderer: renderer ?? null,
      vendor: vendor ?? null,
    };
  } catch {
    return { acceleration: "unavailable", renderer: null, vendor: null };
  } finally {
    canvas?.remove();
  }
}
