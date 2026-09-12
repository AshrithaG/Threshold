'use client';

// ---------------------------------------------------------------------------
// lib/voice.ts — per-device speech.
//
// The whole premise of Threshold is that five phones in one room say five
// DIFFERENT things. So speech is per-device, interruptible, deduped, and
// mutable by the person holding the phone.
//
// Three-tier ladder, each tier degrading silently into the next:
//   grok-realtime  server minted an ephemeral session (inert until XAI_REALTIME=1)
//   grok-tts       server-side xAI TTS through /api/speak
//   browser        window.speechSynthesis
//   silent         no speech surface at all (SSR, or a browser with neither)
//
// Nothing here reads a secret: the browser only ever learns which TIER it is
// on. All xAI wire format lives in app/api/speak + app/api/voice/token.
//
// Concurrency model: exactly one pump loop drains the queue. An interrupt
// bumps `generation`, clears the queue, force-resolves the in-flight
// utterance and lets the SAME loop pick up the new line — so two lines can
// never overlap on one device.
// ---------------------------------------------------------------------------

export type VoiceMode = 'grok-realtime' | 'grok-tts' | 'browser' | 'silent';

interface Utterance {
  text: string;
  urgency: 'now' | 'soon';
}

/** Probe budget for /api/voice/token. Past this we just use the browser. */
const TOKEN_TIMEOUT_MS = 2500;
/** Budget for one /api/speak round trip before we fall back to local speech. */
const SPEAK_TIMEOUT_MS = 3000;
/** Identical text inside this window is a React re-render, not a new order. */
const DEDUPE_MS = 4000;
/** Hard ceiling so a wedged audio element can never freeze the queue. */
const PLAYBACK_WATCHDOG_MS = 20000;
/** Non-urgent backlog cap. Stale instructions are worse than no instructions. */
const MAX_QUEUE = 3;

const STORAGE_KEY = 'threshold.voice.enabled';

let mode: VoiceMode | null = null;
let initPromise: Promise<void> | null = null;

let enabledCache: boolean | null = null;

const queue: Utterance[] = [];
let pumping = false;

let lastText = '';
let lastAt = 0;

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
/** Chrome garbage-collects utterances mid-sentence; hold a hard reference. */
let currentUtterance: SpeechSynthesisUtterance | null = null;
let cachedVoice: SpeechSynthesisVoice | null = null;
/**
 * Resolver for whatever is playing right now. cancelAll() calls it so an
 * interrupt never has to wait on an engine event that some browsers drop.
 */
let finishCurrent: (() => void) | null = null;
/** Bumped on every cancel so a resolving playback cannot revive a dead turn. */
let generation = 0;

// --------------------------------------------------------------------------
// environment probes (all SSR-safe)
// --------------------------------------------------------------------------

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function synth(): SpeechSynthesis | null {
  if (!hasWindow()) return null;
  try {
    return window.speechSynthesis || null;
  } catch {
    return null;
  }
}

/** What we can do before initVoice() has had a chance to run. */
function baselineMode(): VoiceMode {
  return synth() ? 'browser' : 'silent';
}

// --------------------------------------------------------------------------
// mute flag
// --------------------------------------------------------------------------

/**
 * Hard mute, persisted per device. Default ENABLED — but note that browsers
 * block audio until a user gesture, so "enabled" is permission, not proof of
 * sound. voiceMode() reports the honest tier separately.
 */
export function voiceEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  if (!hasWindow()) return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    enabledCache = raw === null ? true : raw === '1';
  } catch {
    enabledCache = true; // private mode / blocked storage
  }
  return enabledCache;
}

export function setVoiceEnabled(on: boolean): void {
  enabledCache = !!on;
  if (hasWindow()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabledCache ? '1' : '0');
    } catch {
      /* storage blocked — the in-memory flag still holds for this session */
    }
  }
  if (!enabledCache) cancelAll();
}

export function voiceMode(): VoiceMode {
  return mode ?? baselineMode();
}

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------

/**
 * Probe the server for the best available tier. Resolves within ~TOKEN_TIMEOUT_MS
 * and never throws or rejects — worst case we land on 'browser'.
 * Safe to await from several components; the probe runs once.
 */
export async function initVoice(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!hasWindow()) {
      mode = 'silent';
      return;
    }

    // Start with what this browser can do unaided, so any failure below is
    // already standing on a working floor.
    mode = baselineMode();
    voiceEnabled(); // hydrate the mute flag from localStorage
    warmVoices();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
    try {
      const res = await fetch('/api/voice/token', {
        method: 'GET',
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        const claimed = data && typeof data.mode === 'string' ? data.mode : '';
        if (claimed === 'grok-realtime') {
          // Accept the top tier only if the session is actually usable: an
          // ephemeral secret that has not already expired. Otherwise the
          // server-side TTS route is still a better bet than local speech.
          const secret = typeof data.clientSecret === 'string' ? data.clientSecret : '';
          const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0;
          mode = secret && expiresAt > Date.now() ? 'grok-realtime' : 'grok-tts';
        } else if (claimed === 'grok-tts') {
          mode = 'grok-tts';
        }
        // Anything else (including {mode:'browser'}) leaves the baseline alone.
      }
    } catch {
      // Aborted, offline, or the route is not deployed. Baseline stands.
    } finally {
      clearTimeout(timer);
    }
  })();
  return initPromise;
}

/**
 * speechSynthesis.getVoices() is empty on first call in Chrome/Safari until the
 * list loads asynchronously. Kick it and latch the result.
 */
function warmVoices(): void {
  const s = synth();
  if (!s) return;
  try {
    cachedVoice = pickVoice(s);
    if (!cachedVoice && typeof s.addEventListener === 'function') {
      const onChange = () => {
        cachedVoice = pickVoice(s);
        try {
          s.removeEventListener('voiceschanged', onChange);
        } catch {
          /* older engines */
        }
      };
      s.addEventListener('voiceschanged', onChange);
    }
  } catch {
    cachedVoice = null;
  }
}

function pickVoice(s: SpeechSynthesis): SpeechSynthesisVoice | null {
  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = s.getVoices() || [];
  } catch {
    return null;
  }
  if (!voices.length) return null;
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
  const pool = english.length ? english : voices;
  // Prefer voices that are clear and present on most machines.
  const preferred = ['samantha', 'google us english', 'aria', 'daniel', 'karen', 'alex'];
  for (const want of preferred) {
    const hit = pool.find((v) => (v.name || '').toLowerCase().includes(want));
    if (hit) return hit;
  }
  return pool.find((v) => v.default) || pool[0];
}

// --------------------------------------------------------------------------
// speak
// --------------------------------------------------------------------------

/**
 * Say something on THIS device.
 *
 * opts.interrupt defaults to true for urgency 'now' (a reassignment must talk
 * over a stale instruction) and false for 'soon' (two calm lines take turns).
 * Identical text inside DEDUPE_MS is dropped, so a re-rendering component
 * cannot make the phone stutter.
 */
export function speak(text: string, opts?: { interrupt?: boolean; urgency?: 'now' | 'soon' }): void {
  if (!hasWindow()) return;
  if (!voiceEnabled()) return;

  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return;

  const urgency = opts?.urgency ?? 'soon';
  const interrupt = opts?.interrupt ?? urgency === 'now';

  const now = Date.now();
  if (clean === lastText && now - lastAt < DEDUPE_MS) return;
  lastText = clean;
  lastAt = now;

  if (mode === null) {
    mode = baselineMode();
    // Fire the probe but do not wait on it — the line goes out now.
    void initVoice();
  }

  if (interrupt) cancelAll();

  queue.push({ text: clean, urgency });
  // Drop the oldest non-urgent backlog rather than reading out stale orders.
  while (queue.length > MAX_QUEUE) {
    const idx = queue.findIndex((q) => q.urgency !== 'now');
    queue.splice(idx === -1 ? 0 : idx, 1);
  }

  void pump();
}

/**
 * Single-flight drain of the queue. An interrupt resolves the in-flight
 * utterance and re-fills the queue, and this same loop picks the new line up
 * on its next pass — which is why nothing here re-enters.
 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      try {
        await play(next);
      } catch {
        /* play() degrades internally; never let one line break the loop */
      }
    }
  } finally {
    pumping = false;
  }
}

async function play(item: Utterance): Promise<void> {
  const m = voiceMode();
  if (m === 'silent') return;

  // 'grok-realtime' currently rides the same server route as 'grok-tts': the
  // duplex client is not wired up (the token route's realtime block is inert).
  // Routing it here means the top tier still makes sound today, and swapping in
  // a realtime transport later touches only this branch.
  if (m === 'grok-tts' || m === 'grok-realtime') {
    const turn = generation;
    const ok = await playRemote(item);
    if (ok) return;
    // Interrupted rather than failed: the line is stale, do not re-speak it
    // and do not blame the remote tier for it.
    if (turn !== generation) return;
    // Genuine failure. Downgrade this device for the rest of the scene and
    // re-speak locally — the responder must still hear the instruction.
    mode = synth() ? 'browser' : 'silent';
    if (mode === 'silent') return;
  }

  await playBrowser(item);
}

/** Server TTS. Resolves true only if audio actually reached the speaker. */
function playRemote(item: Utterance): Promise<boolean> {
  const turn = generation;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let url: string | null = null;
    let audio: HTMLAudioElement | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (watchdog !== null) clearTimeout(watchdog);
      if (finishCurrent === cancelHook) finishCurrent = null;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.onpause = null;
        if (currentAudio === audio) currentAudio = null;
      }
      if (url) {
        if (currentUrl === url) currentUrl = null;
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* already revoked */
        }
      }
      resolve(ok);
    };
    // What cancelAll() calls: playback was cut short, so report "not played"
    // and let play() notice the generation bump.
    const cancelHook = () => settle(false);

    const ctrl = new AbortController();
    const fetchTimer = setTimeout(() => ctrl.abort(), SPEAK_TIMEOUT_MS);

    fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.text }),
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        clearTimeout(fetchTimer);
        // 204 = server has no key / upstream failed. Non-audio is a miss too.
        if (!res.ok || res.status === 204) return settle(false);
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (!type.startsWith('audio/')) return settle(false);

        const blob = await res.blob();
        if (!blob || blob.size < 256) return settle(false); // empty / truncated
        if (turn !== generation) return settle(false); // superseded mid-download

        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.preload = 'auto';
        currentAudio = audio;
        currentUrl = url;
        finishCurrent = cancelHook;
        watchdog = setTimeout(() => settle(false), PLAYBACK_WATCHDOG_MS);

        audio.onended = () => settle(true);
        audio.onerror = () => settle(false);
        audio.onpause = () => {
          // Natural end fires onended first; a pause before that is a cancel.
          if (audio && !audio.ended) settle(false);
        };

        const started = audio.play();
        if (started && typeof started.catch === 'function') {
          // Autoplay blocked (no user gesture yet) — a miss, so the caller
          // falls through to speechSynthesis.
          started.catch(() => settle(false));
        }
      })
      .catch(() => {
        clearTimeout(fetchTimer);
        settle(false); // timeout, offline, bad blob
      });
  });
}

/** Local speechSynthesis. Always resolves, even if the engine goes quiet. */
function playBrowser(item: Utterance): Promise<void> {
  const s = synth();
  if (!s) return Promise.resolve();
  const turn = generation;

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      if (finishCurrent === finish) finishCurrent = null;
      currentUtterance = null;
      resolve();
    };
    // Roughly speech duration plus slack, so a swallowed onend cannot wedge the
    // queue on engines that drop events.
    const budget = Math.min(PLAYBACK_WATCHDOG_MS, 2500 + item.text.length * 90);
    const watchdog = setTimeout(finish, budget);

    try {
      const u = new SpeechSynthesisUtterance(item.text);
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      if (!cachedVoice) cachedVoice = pickVoice(s);
      if (cachedVoice) {
        u.voice = cachedVoice;
        if (cachedVoice.lang) u.lang = cachedVoice.lang;
      } else {
        u.lang = 'en-US';
      }
      u.onend = finish;
      u.onerror = finish;
      currentUtterance = u;
      finishCurrent = finish;

      if (turn !== generation) {
        finish();
        return;
      }
      // Chrome can leave the queue paused after a cancel; nudge it awake.
      try {
        s.resume();
      } catch {
        /* not all engines implement resume */
      }
      s.speak(u);
    } catch {
      finish();
    }
  });
}

/**
 * Stop everything now: pending queue, current playback, and the engine.
 * Deliberately does NOT touch `pumping` — the live pump loop stays the single
 * owner of the queue and will pick up whatever speak() enqueues next.
 */
function cancelAll(): void {
  generation++;
  queue.length = 0;

  const audio = currentAudio;
  if (audio) {
    try {
      audio.pause();
      audio.src = '';
    } catch {
      /* element already detached */
    }
  }

  const s = synth();
  if (s) {
    try {
      s.cancel();
    } catch {
      /* engine busy */
    }
  }
  currentUtterance = null;

  // Force-resolve the in-flight utterance instead of waiting on an engine
  // event some browsers never deliver. settle() clears currentAudio/currentUrl
  // and revokes the blob URL.
  const finisher = finishCurrent;
  finishCurrent = null;
  if (finisher) finisher();
}
