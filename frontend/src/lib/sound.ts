/**
 * Distinct, dependency-free audio cues for a win vs. a loss, synthesized
 * on the fly with the Web Audio API — no external sound assets to fetch
 * or license. These play *alongside* the native desktop Notification
 * (which handles the OS's own default alert ping); this is the app's own
 * in-tab confirmation chime.
 */

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;

  if (!sharedContext) {
    sharedContext = new AudioContextCtor();
  }
  // Browsers suspend a freshly-created context until a user gesture; resume
  // is a no-op if it's already running.
  void sharedContext.resume();
  return sharedContext;
}

function playTone(ctx: AudioContext, frequency: number, startOffset: number, duration: number, peakGain = 0.2): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;

  const startTime = ctx.currentTime + startOffset;
  const endTime = startTime + duration;

  // Quick attack, smooth exponential decay — avoids a harsh digital click.
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

  oscillator.connect(gain);
  gain.connect(ctx.destination);

  oscillator.start(startTime);
  oscillator.stop(endTime + 0.02);
}

/** Bright ascending two-tone chime — plays on a TARGET_HIT (win). */
export function playWinChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, 880, 0, 0.14); // A5
    playTone(ctx, 1318.5, 0.12, 0.22); // E6
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[sound] Failed to play win chime:', error);
  }
}

/** Low descending two-tone buzz — plays on a STOPLOSS_HIT (loss). */
export function playLossChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    playTone(ctx, 392, 0, 0.16, 0.22); // G4
    playTone(ctx, 293.66, 0.14, 0.26, 0.22); // D4
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[sound] Failed to play loss chime:', error);
  }
}
