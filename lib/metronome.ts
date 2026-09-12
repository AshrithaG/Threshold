'use client';

// ---------------------------------------------------------------------------
// lib/metronome.ts — the safety-critical path.
//
// This file has ZERO network dependency, zero API keys, zero LLM involvement.
// It is pure WebAudio and must keep pacing a human's hands with the wifi off,
// every env var blank, and React re-rendering the tree around it.
//
// Timing model: look-ahead scheduling (the standard "A Tale of Two Clocks"
// pattern). A 25ms setInterval acts only as a *waker*; every click is stamped
// onto the AudioContext's own sample clock 100ms ahead of time. setInterval
// jitter therefore never reaches the beat, so the pulse does not drift or
// stutter when the main thread is busy painting.
// ---------------------------------------------------------------------------

/** Scheduler wake interval. Coarse on purpose — it only tops up the queue. */
const LOOKAHEAD_MS = 25;
/** How far ahead of ctx.currentTime we commit clicks, in seconds. */
const SCHEDULE_AHEAD_S = 0.1;
/** Click envelope length in seconds (~40ms percussive tick). */
const CLICK_S = 0.04;
/** Oscillator frequency for the tick. ~1kHz cuts through room noise. */
const CLICK_HZ = 1000;
/** Peak gain of a tick. Loud enough to pace by, not loud enough to distort. */
const CLICK_GAIN = 0.32;

/** AHA-style adult compression window. 110 sits in the middle of 100-120. */
const MIN_BPM = 60;
const MAX_BPM = 180;
const DEFAULT_BPM = 110;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let timerId: ReturnType<typeof setInterval> | null = null;
let nextNoteTime = 0;
let currentBpm = DEFAULT_BPM;
let running = false;

/** Live nodes, so stopMetronome() can silence anything already committed. */
const live = new Set<{ osc: OscillatorNode; gain: GainNode }>();

function clampBpm(bpm: number): number {
  if (typeof bpm !== 'number' || !isFinite(bpm)) return DEFAULT_BPM;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

/**
 * Lazily build (and reuse) one AudioContext for the life of the tab.
 * Browsers hand it to us in a "suspended" state until a user gesture, so every
 * caller also nudges resume(). Returns null on the server or on a browser with
 * no WebAudio at all — never throws.
 */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const AC: typeof AudioContext | undefined =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/** Commit one percussive click at an absolute AudioContext timestamp. */
function scheduleClick(c: AudioContext, when: number): void {
  if (!master) return;
  let osc: OscillatorNode;
  let gain: GainNode;
  try {
    osc = c.createOscillator();
    gain = c.createGain();
  } catch {
    return;
  }
  osc.type = 'square';
  osc.frequency.setValueAtTime(CLICK_HZ, when);
  // Drop the pitch across the tick so it reads as a "tock", not a beep.
  osc.frequency.exponentialRampToValueAtTime(CLICK_HZ * 0.5, when + CLICK_S);

  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(CLICK_GAIN, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_S);

  osc.connect(gain);
  gain.connect(master);

  const entry = { osc, gain };
  live.add(entry);
  osc.onended = () => {
    live.delete(entry);
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* node already torn down */
    }
  };

  try {
    osc.start(when);
    osc.stop(when + CLICK_S + 0.01);
  } catch {
    live.delete(entry);
  }
}

/**
 * Top up the schedule. Runs every LOOKAHEAD_MS while the metronome is on.
 * Background tabs throttle setInterval hard, which would otherwise leave a
 * backlog of past-due beats and fire them as one burst on refocus — the
 * resync guard below collapses that backlog instead.
 */
function scheduler(): void {
  const c = ctx;
  if (!c || !running) return;

  const spb = 60 / currentBpm;

  // Backlog guard: if we fell more than a beat behind (tab was hidden, thread
  // was blocked), restart the grid from now rather than machine-gunning.
  if (nextNoteTime < c.currentTime - spb) {
    nextNoteTime = c.currentTime + 0.05;
  }

  while (nextNoteTime < c.currentTime + SCHEDULE_AHEAD_S) {
    scheduleClick(c, nextNoteTime);
    nextNoteTime += 60 / currentBpm; // re-read each pass so bpm changes glide in
  }
}

/**
 * Start pacing, or re-tune an already-running metronome.
 *
 * Calling this twice never double-schedules: the second call only updates the
 * tempo (and re-resumes the context), so a React effect that fires on every
 * render is harmless.
 */
export function startMetronome(bpm: number = DEFAULT_BPM): void {
  if (typeof window === 'undefined') return;
  const target = clampBpm(bpm);

  const c = getCtx();
  if (!c) {
    // No WebAudio on this browser. Record the tempo, stay honest about state:
    // metronomeRunning() will report false so the UI can say so.
    currentBpm = target;
    return;
  }

  // Browsers suspend audio until a user gesture; resume on every start.
  if (c.state === 'suspended') {
    const wasIdle = !running;
    c.resume()
      .then(() => {
        // Re-anchor the grid to the clock that just started moving.
        if (running && wasIdle) nextNoteTime = c.currentTime + 0.06;
      })
      .catch(() => {
        /* still gesture-blocked; the next start() will try again */
      });
  }

  if (running) {
    currentBpm = target; // live re-tune, scheduler picks it up on the next pass
    return;
  }

  currentBpm = target;
  running = true;
  nextNoteTime = c.currentTime + 0.06;
  scheduler(); // prime immediately so the first beat is not a full tick away
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
}

/** Stop the scheduler and silence anything already committed to the graph. */
export function stopMetronome(): void {
  running = false;
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  const c = ctx;
  for (const entry of Array.from(live)) {
    try {
      entry.gain.gain.cancelScheduledValues(c ? c.currentTime : 0);
      entry.gain.gain.setValueAtTime(0.0001, c ? c.currentTime : 0);
      entry.osc.stop(c ? c.currentTime : 0);
    } catch {
      /* already stopped or never started */
    }
    live.delete(entry);
  }
  nextNoteTime = 0;
}

/** True while clicks are actually being scheduled. */
export function metronomeRunning(): boolean {
  return running;
}
