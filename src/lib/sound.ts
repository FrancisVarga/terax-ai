/**
 * Zero-asset notification sounds via the Web Audio API.
 *
 * We synthesize short tones with an oscillator instead of bundling an audio
 * file: no binary asset to ship, no asset-path wiring, and the success/failure
 * outcome is encoded in the pitch contour (ascending = good, descending = bad)
 * so it reads without looking at the screen.
 *
 * A single AudioContext is reused — browsers cap the number you may create, and
 * creating one per beep leaks. It is built lazily on first play: autoplay
 * policies require a prior user gesture, and by the time anything finishes the
 * user has already clicked to start it, so the context resumes cleanly.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  // A context can be left "suspended" by the autoplay policy; nudge it back.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Play one tone at `freq` Hz starting `at` seconds from now, lasting `dur`. */
function tone(
  ac: AudioContext,
  freq: number,
  at: number,
  dur: number,
): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;

  const start = ac.currentTime + at;
  const end = start + dur;
  // Short attack + exponential release keeps it a soft chime, not a click.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

/**
 * Play a completion chime. `success` picks an ascending major interval; failure
 * picks a descending one. Silently no-ops when Web Audio is unavailable.
 */
export function playCompletionSound(success: boolean): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    if (success) {
      tone(ac, 1046.5, 0, 0.12); // C6
      tone(ac, 1318.5, 0.11, 0.18); // E6
    } else {
      tone(ac, 880.0, 0, 0.14); // A5
      tone(ac, 698.46, 0.13, 0.22); // F5
    }
  } catch {
    /* an AudioContext can throw if the page is being torn down */
  }
}
