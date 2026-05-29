import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { probeGpuStatus } from "./gpuStatus";
import {
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalWordNavigationSequence,
} from "./keymap";

// Must comfortably exceed the largest single-tab pane count. The 2x2 Claude
// grid puts 4 panes in one tab; with any slot still held by a deactivating
// tab during a switch, a cap of 5 forces eviction of a still-visible sibling
// (permanent blank pane — the evicted leaf has no rebind trigger). 8 gives a
// 4-pane grid headroom; pickSlotFor also treats this as a soft cap and grows
// rather than ever evicting a visible leaf.
export const POOL_MAX_SIZE = 8;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;

export type SlotAdapter = {
  resolveLeaf(leafId: number): LeafBridge | null;
  evictLeaf(leafId: number): void;
  isLeafFocused(leafId: number): boolean;
  // A visible leaf is on-screen in the active tab. Evicting its slot blanks
  // the pane with no way to recover (the bind is edge-triggered by React
  // effect deps that don't change on eviction), so pickSlotFor must never
  // choose a visible leaf's slot as a victim.
  isLeafVisible(leafId: number): boolean;
};

export type LeafBridge = {
  writeToPty(data: string): void;
  resizePty(cols: number, rows: number): void;
  // Force a SIGWINCH on the underlying PTY at the given dims. Implemented
  // as a +1 row / restore bump because the Linux kernel suppresses winsize
  // ioctls that don't actually change the size. Used to make alt-screen
  // TUIs repaint from scratch after they were dormant.
  kickPty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentLeafId: number | null;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  // Most recent box from the ResizeObserver callback, captured without a
  // layout flush; read by the debounced fit instead of re-querying the DOM.
  pendingW: number;
  pendingH: number;
  lastUsedAt: number;
  // Set when WebGL was disposed because the slot went dormant; tells the next
  // unhide to reattach the renderer before repainting.
  webglDormant: boolean;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;

export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl && recyclerEl.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-terax-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

const MCR_BG_ACTIVE = 4.5;
const MCR_BG_INACTIVE = 1;

function bgActive(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return prefs.backgroundKind === "image" && !!prefs.backgroundImageId;
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  return {
    fontFamily: prefs.terminalFontFamily || detectMonoFontFamily(),
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: "bar" as const,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    allowProposedApi: true,
    minimumContrastRatio: bgActive(prefs) ? MCR_BG_ACTIVE : MCR_BG_INACTIVE,
  };
}

export function applyBackgroundActive(active: boolean): void {
  const value = active ? MCR_BG_ACTIVE : MCR_BG_INACTIVE;
  for (const slot of slots) {
    if (slot.term.options.minimumContrastRatio === value) continue;
    slot.term.options.minimumContrastRatio = value;
  }
}

function createSlot(): Slot {
  const term = new Terminal(termOptions());
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => openUrl(uri).catch(console.error)),
  );

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-terax-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentLeafId: null,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    unhideRaf: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    pendingW: 0,
    pendingH: 0,
    lastUsedAt: 0,
    webglDormant: false,
  };

  attachWebgl(slot);

  term.attachCustomKeyEventHandler((event) => {
    // During IME composition the browser is assembling a multi-keystroke
    // character (Chinese pinyin → hanzi, Korean jamo → syllable, etc.).
    // Raw keydown events — including the Enter that commits a candidate —
    // must NOT be forwarded to the PTY; xterm will receive the final
    // composed string through its own compositionend handler instead.
    // key === "Process" is what every current engine (WebView2/Chromium,
    // WKWebView, WebKitGTK) reports for any key pressed inside an active IME
    // session when isComposing is not yet set. Replaces the deprecated
    // keyCode === 229 check — all webviews Terax targets surface "Process".
    if (event.isComposing || event.key === "Process") return false;

    const leafId = slot.currentLeafId;
    if (leafId === null) return false;
    const bridge = adapter?.resolveLeaf(leafId);
    if (!bridge) return true;
    const lineNavigation = terminalLineNavigationSequence(event, {
      isMac: IS_MAC,
    });
    if (lineNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(lineNavigation);
      return false;
    }
    const wordNavigation = terminalWordNavigationSequence(event);
    if (wordNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(wordNavigation);
      return false;
    }
    const deleteSeq = terminalDeleteSequence(event, { isMac: IS_MAC });
    if (deleteSeq) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(deleteSeq);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    if (isTerminalCopy(event)) {
      if (event.type === "keydown" && slot.term.hasSelection()) {
        const sel = slot.term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      }
      event.preventDefault();
      return false;
    }
    if (isTerminalPaste(event)) {
      if (event.type === "keydown") {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) slot.term.paste(text);
          })
          .catch(() => {});
      }
      event.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return;
    adapter?.resolveLeaf(leafId)?.writeToPty(data);
  });

  slots.push(slot);
  ensureDormantSweep();
  return slot;
}

type PickResult = { slot: Slot; previousLeafId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function pickSlotFor(leafId: number): PickResult {
  const free = slots.find((s) => s.currentLeafId === null);
  if (free) return { slot: free, previousLeafId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousLeafId: null };

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentLeafId === leafId) return { slot: s, previousLeafId: null };
    // A visible leaf must never be evicted — its pane would blank permanently
    // (the rebind is edge-triggered by React effect deps that don't change on
    // eviction). Skip it as a candidate entirely.
    const visible =
      s.currentLeafId !== null &&
      (adapter?.isLeafVisible(s.currentLeafId) ?? false);
    if (visible) continue;
    const focused =
      s.currentLeafId !== null &&
      (adapter?.isLeafFocused(s.currentLeafId) ?? false);
    const score =
      (isAltScreen(s) ? 100 : 0) + (focused ? 10 : 0) + s.lastUsedAt / 1e12;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // Every slot holds a visible leaf (more on-screen panes than the soft cap).
  // Growing the pool past POOL_MAX_SIZE is correct here — better to spend an
  // extra renderer than to blank a visible pane. The dormant sweep reclaims
  // the WebGL contexts of these extra slots once they go off-screen.
  if (!best) return { slot: createSlot(), previousLeafId: null };
  return { slot: best, previousLeafId: best.currentLeafId };
}

export type AcquireParams = {
  leafId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the time it was released. When set, bindSlot skips ring replay
  // and kicks SIGWINCH so the TUI repaints from scratch.
  altScreen: boolean;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  searchQuery: string | null;
  cols: number;
  rows: number;
  registerOsc: (term: Terminal) => (() => void)[];
  onSearchReady: (addon: SearchAddon) => void;
};

export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentLeafId === params.leafId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.leafId);
  if (pick.previousLeafId !== null) {
    adapter?.evictLeaf(pick.previousLeafId);
  }
  if (
    pick.slot.currentLeafId !== null &&
    pick.slot.currentLeafId !== params.leafId
  ) {
    detachSlotFromLeaf(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

// Above this, a one-shot term.write of the whole serialized snapshot parses
// every line in a single internal flush before xterm yields, hitching the
// frame on pane switch. Replaying in line-bounded chunks lets xterm's write
// scheduler interleave parsing across tasks. Line boundaries guarantee we
// never slice a CSI/SGR escape run mid-sequence.
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;

function writeSnapshotChunked(slot: Slot, snapshot: string): void {
  if (snapshot.length <= SNAPSHOT_CHUNK_BYTES) {
    try {
      slot.term.write(snapshot);
    } catch (e) {
      console.warn("[terax] snapshot replay failed:", e);
    }
    return;
  }
  // Split on newline boundaries, accumulating up to ~chunk size per write.
  let start = 0;
  while (start < snapshot.length) {
    let end = start + SNAPSHOT_CHUNK_BYTES;
    if (end < snapshot.length) {
      const nl = snapshot.indexOf("\n", end);
      end = nl === -1 ? snapshot.length : nl + 1;
    } else {
      end = snapshot.length;
    }
    try {
      slot.term.write(snapshot.slice(start, end));
    } catch (e) {
      console.warn("[terax] snapshot replay failed:", e);
      return;
    }
    start = end;
  }
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  // Stale when WebGL is missing (incl. dormancy-disposed), or the slot has been
  // idle long enough that its last paint can't be trusted — either way the
  // unhide path reattaches WebGL and forces a full repaint.
  const stale =
    !slot.webglAddon ||
    slot.webglDormant ||
    performance.now() - slot.lastUsedAt > SLOT_STALE_MS;
  slot.currentLeafId = p.leafId;
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "hidden";

  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }

  slot.term.options.disableStdin = p.shellExited;
  slot.term.clear();
  slot.term.reset();

  if (
    p.cols > 0 &&
    p.rows > 0 &&
    (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
  ) {
    slot.term.resize(p.cols, p.rows);
  }

  if (p.snapshot) {
    writeSnapshotChunked(slot, p.snapshot);
  }
  if (p.altScreen) {
    // Discard the dormant ring. TUI output is incremental cursor-positioned
    // updates that can't be replayed coherently on top of a stale snapshot
    // — see the SIGWINCH kick below, which makes the TUI redraw from scratch.
    p.drainRing(() => {});
  } else {
    p.drainRing((bytes) => slot.term.write(bytes));
  }
  try {
    slot.term.write("\x1b[?25h");
  } catch {}

  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = p.registerOsc(slot.term);

  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
    // resizePty updates session.cols/rows + pty backend; no separate scope call.
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  }

  if (p.searchQuery) {
    try {
      slot.searchAddon.findNext(p.searchQuery);
    } catch {}
  }

  applyCursorBlinkOnSlot(slot, adapter?.isLeafFocused(p.leafId) ?? false);

  if (p.altScreen && !p.shellExited) {
    adapter?.resolveLeaf(p.leafId)?.kickPty(slot.term.cols, slot.term.rows);
  }

  scheduleUnhide(slot, stale);

  p.onSearchReady(slot.searchAddon);
}

function scheduleUnhide(slot: Slot, stale: boolean): void {
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => {
      slot.unhideRaf = null;
      slot.host.style.visibility = "";
      if (stale) {
        if (!slot.webglAddon) attachWebgl(slot);
        try {
          slot.term.refresh(0, slot.term.rows - 1);
        } catch {}
      }
      const leafId = slot.currentLeafId;
      if (leafId !== null && adapter?.isLeafFocused(leafId)) {
        slot.term.focus();
      }
    });
  });
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  p.onSearchReady(slot.searchAddon);
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentLeafId !== p.leafId) return;
    if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
      return;
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  };

  slot.observer = new ResizeObserver((entries) => {
    // Read the box the browser already computed for this callback instead of
    // touching container.clientWidth/Height, which forces a synchronous layout
    // flush. During a window drag-resize the observer fires continuously, so
    // avoiding the reflow per tick keeps resizing smooth.
    const box = entries[0]?.contentBoxSize?.[0];
    if (box) {
      slot.pendingW = Math.round(box.inlineSize);
      slot.pendingH = Math.round(box.blockSize);
    } else {
      slot.pendingW = container.clientWidth;
      slot.pendingH = container.clientHeight;
    }
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentLeafId !== p.leafId) return;
      const w = slot.pendingW;
      const h = slot.pendingH;
      // Skip only when the box is unchanged AND already non-zero. A pane that
      // binds before its panel has laid out (e.g. a terminal that is the active
      // tab at window launch) measures 0×0 on the eager fit; without this the
      // guard would treat the first real 0→0 observation as "settled" and the
      // corrective fit, once the panel sizes up, could be suppressed. Treating
      // any zero dimension as not-yet-settled guarantees the refit runs.
      if (w === slot.lastW && h === slot.lastH && w > 0 && h > 0) return;
      slot.lastW = w;
      slot.lastH = h;
      if (w <= 0 || h <= 0) return; // nothing to fit against yet
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

export type SerializeOutput = {
  snapshot: string | null;
  cols: number;
  rows: number;
  altScreen: boolean;
};

export function releaseSlot(leafId: number): SerializeOutput | null {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return null;
  const out = serializeSlot(slot);
  detachSlotFromLeaf(slot);
  return out;
}

function serializeSlot(slot: Slot): SerializeOutput {
  let snapshot: string | null = null;
  try {
    const cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
  } catch (e) {
    console.warn("[terax] serialize failed:", e);
  }
  return {
    snapshot,
    cols: slot.term.cols,
    rows: slot.term.rows,
    altScreen: isAltScreen(slot),
  };
}

function detachSlotFromLeaf(slot: Slot): void {
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  if (slot.host.parentNode !== getRecycler()) {
    getRecycler().appendChild(slot.host);
  }

  slot.currentLeafId = null;
  slot.lastUsedAt = performance.now();
}

const WEBGL_RECOVERY_DELAY_MS = 250;
// Below this a re-shown slot is fresh enough to trust; above it, repaint on
// unhide to defeat silent GPU/context staleness.
const SLOT_STALE_MS = 10_000;

// The GPU backend is fixed for the lifetime of the webview process, so probe
// once and cache. On a software backend (SwiftShader / llvmpipe / WARP) xterm's
// WebGL renderer is actually SLOWER than the DOM renderer — every glyph-atlas
// upload runs on the CPU with GL overhead piled on top — so we skip WebGL there
// and let xterm fall back to DOM. "unavailable" (no WebGL at all) also skips.
let cachedWebglWorthwhile: boolean | null = null;
function webglWorthwhile(): boolean {
  if (cachedWebglWorthwhile === null) {
    const status = probeGpuStatus();
    cachedWebglWorthwhile = status.acceleration === "hardware";
    if (!cachedWebglWorthwhile) {
      console.info(
        `[terax-webgl] GPU backend "${status.renderer ?? "unknown"}" (${status.acceleration}) — using DOM renderer for better performance`,
      );
    }
  }
  return cachedWebglWorthwhile;
}

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  if (!webglWorthwhile()) return;
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch {}
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      setTimeout(() => {
        if (slot.webglAddon) return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
    slot.webglDormant = false;
  } catch (e) {
    console.warn("[terax-webgl] unavailable:", e);
  }
}

// Idle GPU reclaim. Each live WebglAddon holds a glyph-atlas texture + a WebGL2
// context; with POOL_MAX_SIZE slots that's up to 5 contexts pinned even when
// only one pane is visible. On weak GPUs this raises context-loss risk (and a
// loss forces a full repaint hitch). Sweep periodically and dispose WebGL on
// slots that are unbound and stale, marking them so the next bind reattaches
// before unhide. Disabled while the pool is small enough to be cheap.
const DORMANT_SWEEP_MS = SLOT_STALE_MS;
let dormantSweepTimer: ReturnType<typeof setInterval> | null = null;

function sweepDormantWebgl(): void {
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  const now = performance.now();
  for (const slot of slots) {
    if (slot.currentLeafId !== null) continue; // bound/visible — keep hot
    if (!slot.webglAddon) continue;
    if (now - slot.lastUsedAt < SLOT_STALE_MS) continue;
    disposeSlotWebgl(slot);
    slot.webglDormant = true;
  }
}

function ensureDormantSweep(): void {
  if (dormantSweepTimer !== null) return;
  dormantSweepTimer = setInterval(sweepDormantWebgl, DORMANT_SWEEP_MS);
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[terax-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch {}
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch {}
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch {}
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled && !slot.webglAddon) attachWebgl(slot);
    else if (!enabled && slot.webglAddon) disposeSlotWebgl(slot);
  }
}

export function applyFontSize(size: number): void {
  for (const slot of slots) {
    if (slot.term.options.fontSize === size) continue;
    slot.term.options.fontSize = size;
    slot.fitAddon.fit();
    if (slot.currentLeafId !== null) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      const bridge = adapter?.resolveLeaf(slot.currentLeafId);
      bridge?.resizePty(slot.term.cols, slot.term.rows);
    }
  }
}

export function applyLetterSpacing(spacing: number): void {
  for (const slot of slots) {
    if (slot.term.options.letterSpacing === spacing) continue;
    slot.term.options.letterSpacing = spacing;
    slot.fitAddon.fit();
  }
}

export function applyFontFamily(family: string): void {
  const resolved = family || detectMonoFontFamily();
  for (const slot of slots) {
    if (slot.term.options.fontFamily === resolved) continue;
    slot.term.options.fontFamily = resolved;
    slot.fitAddon.fit();
    if (slot.currentLeafId !== null) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      const bridge = adapter?.resolveLeaf(slot.currentLeafId);
      bridge?.resizePty(slot.term.cols, slot.term.rows);
    }
  }
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  slot?.term.focus();
}

// Re-measure + refit a bound slot. Called after web fonts settle so the cell
// grid that was painted eagerly (possibly with fallback metrics on the very
// first tab) snaps to the real font's cell size. No-op if the dims are already
// correct, so it's cheap on every tab after the first.
export function refitLeaf(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  try {
    slot.fitAddon.fit();
  } catch {}
  if (slot.term.cols !== slot.lastCols || slot.term.rows !== slot.lastRows) {
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    adapter?.resolveLeaf(leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
}

export function setSlotFocused(leafId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = focused;
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForLeaf(leafId: number): Slot | null {
  return slots.find((s) => s.currentLeafId === leafId) ?? null;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

function isTerminalCopy(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyC" || e.key === "c" || e.key === "C")
  );
}

function isTerminalPaste(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}
