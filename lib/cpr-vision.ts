'use client';

// ---------------------------------------------------------------------------
// Threshold — compression rate from the camera.
//
// Pose landmarks (wrists) -> vertical displacement signal -> detrend -> Schmitt
// trigger peak counting -> inter-peak intervals -> bpm.
//
// This module NEVER throws and NEVER hangs. Every failure mode (CDN blocked,
// model 404, no WebGL, no camera, CSP blocking dynamic import) resolves to a
// working VisionHandle that reports onRate(null, 0) exactly once. The camera is
// *confirmation* of the compression rate; the metronome is the primary coaching
// channel and does not depend on anything in here.
//
// It also never invents a number. A still camera pointed at a wall, or a hand
// waved randomly, reports quality 0 and bpm null — a wrong rate would be worse
// than no rate.
// ---------------------------------------------------------------------------

export interface VisionHandle {
  stop(): void;
}

// --- CDN / model ------------------------------------------------------------

const TASKS_VISION_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * Hard ceiling on first-run setup (bundle + wasm + ~5MB model over lobby wifi).
 * Nothing in the UI blocks on this — the metronome is already running — but the
 * promise must not be able to hang forever.
 */
const INIT_TIMEOUT_MS = 12000;

// --- signal processing constants -------------------------------------------

/** Rolling analysis window. */
const WINDOW_MS = 6000;
/** Refuse to emit a bpm until we have this much data. */
const MIN_DATA_MS = 3500;
/** Frame throttle (~30fps). */
const FRAME_INTERVAL_MS = 33;
/** onRate cadence (~4Hz). */
const EMIT_INTERVAL_MS = 250;
/** 240bpm ceiling — rejects double-counting a single compression. */
const MIN_PEAK_GAP_MS = 250;
/** 40bpm floor — an interval longer than this is a dropout, not a compression. */
const MAX_PEAK_GAP_MS = 1500;
/** A wrist below this visibility does not contribute to the signal. */
const WRIST_VIS_MIN = 0.5;
/** Absolute threshold floor, in normalised frame heights. Rejects camera jitter. */
const MIN_ABS_THRESHOLD = 0.006;
/** Peak-to-peak below this is noise, not compressions. */
const MIN_P2P = 0.012;
/** Peak-to-peak at or above this is a confident, well-framed signal. */
const GOOD_P2P = 0.055;
/** Fraction of the recent peak-to-peak used as the hysteresis threshold. */
const THRESHOLD_FRACTION = 0.25;
/** Centred moving-mean half-width used for detrending. */
const DETREND_HALF_MS = 600;
const EMA_ALPHA = 0.3;
const MIN_BPM = 40;
const MAX_BPM = 220;
/** Below this quality we report null rather than guess. */
const EMIT_QUALITY_MIN = 0.35;
/** Forget the smoothed value after this long without a usable reading. */
const EMA_RESET_MS = 1500;

// --- small helpers ----------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = clamp(Math.round((sortedAsc.length - 1) * p), 0, sortedAsc.length - 1);
  return sortedAsc[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(label + ' timed out after ' + ms + 'ms'));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// --- runtime module loading -------------------------------------------------

let tasksVisionPromise: Promise<any> | null = null;

/**
 * Dynamic import the bundler must not try to resolve. `new Function` keeps the
 * specifier completely opaque to webpack/turbopack, so `next build` never tries
 * to fetch or bundle the CDN URL — it is loaded by the browser at runtime.
 */
function importFromCdn(url: string): Promise<any> {
  try {
    const dyn = new Function('u', 'return import(u);') as (u: string) => Promise<any>;
    const r = dyn(url);
    return r && typeof r.then === 'function' ? r : Promise.reject(new Error('bad import'));
  } catch (err) {
    // Some CSPs forbid `new Function`. Fall through to the script-tag path.
    return Promise.reject(err);
  }
}

/** Fallback loader for environments where `new Function` is blocked. */
function importViaScriptTag(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const key = '__thresholdTasksVision';
    const w = window as any;
    if (w[key]) {
      resolve(w[key]);
      return;
    }
    const readyEvent = 'threshold-tasks-vision-ready';
    const script = document.createElement('script');
    script.type = 'module';
    script.textContent =
      'import * as m from ' +
      JSON.stringify(url) +
      '; window[' +
      JSON.stringify(key) +
      '] = m; window.dispatchEvent(new Event(' +
      JSON.stringify(readyEvent) +
      '));';

    const cleanup = () => {
      window.removeEventListener(readyEvent, onReady);
      script.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      if (w[key]) resolve(w[key]);
      else reject(new Error('module loaded but empty'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('module script failed'));
    };

    window.addEventListener(readyEvent, onReady);
    script.addEventListener('error', onError);
    try {
      document.head.appendChild(script);
    } catch (err) {
      cleanup();
      reject(err as Error);
    }
  });
}

function loadTasksVision(): Promise<any> {
  if (!tasksVisionPromise) {
    tasksVisionPromise = importFromCdn(TASKS_VISION_URL)
      .catch(() => importViaScriptTag(TASKS_VISION_URL))
      .then((mod) => {
        if (!mod || !mod.FilesetResolver || !mod.PoseLandmarker) {
          throw new Error('tasks-vision module missing exports');
        }
        return mod;
      })
      .catch((err) => {
        // Allow a later attempt (e.g. wifi came back) to retry from scratch.
        tasksVisionPromise = null;
        throw err;
      });
  }
  return tasksVisionPromise;
}

async function createLandmarker(mod: any): Promise<any> {
  const fileset = await mod.FilesetResolver.forVisionTasks(WASM_BASE);
  const common = {
    runningMode: 'VIDEO' as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  try {
    return await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      ...common,
    });
  } catch (gpuErr) {
    // No WebGL / blocklisted GPU / locked-down browser: CPU is slower but works.
    return await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      ...common,
    });
  }
}

// --- analysis ---------------------------------------------------------------

interface Sample {
  /** ms, performance.now() domain */
  t: number;
  /** normalised wrist height, 0 = top of frame. NaN when wrists were not visible. */
  y: number;
  /** best wrist visibility on this frame, 0..1 */
  vis: number;
}

interface Analysis {
  bpm: number | null;
  quality: number;
}

/**
 * Centred moving mean over an irregularly sampled series, two-pointer, O(n).
 * Centred (rather than trailing) so detrending adds no phase lag to the peaks.
 */
function centredMovingMean(t: number[], y: number[], halfWidthMs: number): number[] {
  const n = t.length;
  const out = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi < n && t[hi] <= t[i] + halfWidthMs) {
      sum += y[hi];
      hi++;
    }
    while (lo < n && t[lo] < t[i] - halfWidthMs) {
      sum -= y[lo];
      lo++;
    }
    const count = hi - lo;
    out[i] = count > 0 ? sum / count : y[i];
  }
  return out;
}

function analyse(buf: Sample[]): Analysis {
  if (buf.length < 10) return { bpm: null, quality: 0 };

  const dataSpan = buf[buf.length - 1].t - buf[0].t;

  // --- visibility / coverage ---
  let visibleCount = 0;
  let visSum = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i].vis >= WRIST_VIS_MIN && Number.isFinite(buf[i].y)) {
      visibleCount++;
      visSum += buf[i].vis;
    }
  }
  const coverage = visibleCount / buf.length;
  const meanVis = visibleCount > 0 ? visSum / visibleCount : 0;
  // 0.5 visibility -> 0, 0.85+ -> 1. Scaled down further if wrists keep dropping out.
  const visQ = clamp((meanVis - WRIST_VIS_MIN) / 0.35, 0, 1) * clamp(coverage / 0.7, 0, 1);

  if (visibleCount < 10 || coverage < 0.5) {
    return { bpm: null, quality: Math.min(visQ, 0.2) };
  }

  const t: number[] = new Array(visibleCount);
  const y: number[] = new Array(visibleCount);
  let k = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i];
    if (s.vis >= WRIST_VIS_MIN && Number.isFinite(s.y)) {
      t[k] = s.t;
      y[k] = s.y;
      k++;
    }
  }

  // --- detrend ---
  const baseline = centredMovingMean(t, y, DETREND_HALF_MS);
  const d = new Array<number>(visibleCount);
  for (let i = 0; i < visibleCount; i++) d[i] = y[i] - baseline[i];

  // --- amplitude (robust peak-to-peak) ---
  const sorted = d.slice().sort((a, b) => a - b);
  const p2p = percentile(sorted, 0.92) - percentile(sorted, 0.08);
  const ampQ = clamp((p2p - MIN_P2P) / (GOOD_P2P - MIN_P2P), 0, 1);

  if (p2p < MIN_P2P) {
    // Camera is steady but nothing is moving: say so, do not guess.
    return { bpm: null, quality: Math.min(visQ * 0.3, 0.25) };
  }

  // --- Schmitt-trigger peak counting ---
  const threshold = Math.max(THRESHOLD_FRACTION * p2p, MIN_ABS_THRESHOLD);
  const peakTimes: number[] = [];
  let state: -1 | 0 | 1 = 0;
  for (let i = 0; i < visibleCount; i++) {
    if (d[i] > threshold) {
      if (state !== 1) {
        state = 1;
        const last = peakTimes.length > 0 ? peakTimes[peakTimes.length - 1] : -Infinity;
        if (t[i] - last >= MIN_PEAK_GAP_MS) peakTimes.push(t[i]);
      }
    } else if (d[i] < -threshold) {
      state = -1;
    }
  }

  // --- intervals ---
  const allIntervals: number[] = [];
  for (let i = 1; i < peakTimes.length; i++) allIntervals.push(peakTimes[i] - peakTimes[i - 1]);
  const good = allIntervals.filter((iv) => iv >= MIN_PEAK_GAP_MS && iv <= MAX_PEAK_GAP_MS);

  if (dataSpan < MIN_DATA_MS || good.length < 2) {
    return { bpm: null, quality: clamp(visQ * ampQ * 0.5, 0, 0.34) };
  }

  const med = median(good);
  if (med <= 0) return { bpm: null, quality: clamp(visQ * ampQ * 0.5, 0, 0.34) };

  // --- periodicity: the guard against "random motion looks like CPR" ---
  const mean = good.reduce((a, b) => a + b, 0) / good.length;
  let varSum = 0;
  for (let i = 0; i < good.length; i++) varSum += (good[i] - mean) * (good[i] - mean);
  const cv = mean > 0 ? Math.sqrt(varSum / good.length) / mean : 1;
  const periQ = clamp(1 - cv / 0.45, 0, 1);
  const keptRatio = allIntervals.length > 0 ? good.length / allIntervals.length : 0;

  const quality = clamp(visQ * ampQ * (0.4 + 0.6 * periQ) * (0.5 + 0.5 * keptRatio), 0, 1);

  const bpm = 60000 / med;
  if (bpm < MIN_BPM || bpm > MAX_BPM) return { bpm: null, quality: Math.min(quality, 0.34) };
  if (quality < EMIT_QUALITY_MIN) return { bpm: null, quality };

  return { bpm, quality };
}

// --- public API -------------------------------------------------------------

/**
 * Start measuring compression rate from `video` (which should already be
 * playing a camera MediaStream). Always resolves. `onRate` is called at ~4Hz
 * with (bpm | null, quality 0..1).
 */
export async function startCompressionTracking(
  video: HTMLVideoElement,
  onRate: (bpm: number | null, quality: number) => void,
): Promise<VisionHandle> {
  let stopped = false;
  let rafId = 0;
  let landmarker: any = null;

  const emit = (bpm: number | null, quality: number) => {
    if (stopped) return;
    try {
      onRate(bpm, quality);
    } catch {
      // A throwing consumer must not kill the loop.
    }
  };

  const stopTracks = () => {
    try {
      const src = video && (video as any).srcObject;
      if (src && typeof src.getTracks === 'function') {
        const tracks = src.getTracks();
        for (let i = 0; i < tracks.length; i++) {
          try {
            tracks[i].stop();
          } catch {
            /* already stopped */
          }
        }
      }
    } catch {
      /* no stream attached */
    }
  };

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    } catch {
      /* no rAF */
    }
    rafId = 0;
    try {
      if (landmarker && typeof landmarker.close === 'function') landmarker.close();
    } catch {
      /* already closed */
    }
    landmarker = null;
    stopTracks();
  };

  /** Handle returned on every failure path: still cleans up the camera. */
  const inertHandle: VisionHandle = {
    stop() {
      teardown();
    },
  };

  if (typeof window === 'undefined' || !video) {
    setTimeout(() => emit(null, 0), 0);
    return inertHandle;
  }

  let mod: any;
  try {
    mod = await withTimeout(loadTasksVision(), INIT_TIMEOUT_MS, 'tasks-vision load');
  } catch {
    setTimeout(() => emit(null, 0), 0);
    return inertHandle;
  }
  if (stopped) return inertHandle;

  try {
    landmarker = await withTimeout(createLandmarker(mod), INIT_TIMEOUT_MS, 'pose landmarker');
  } catch {
    landmarker = null;
    setTimeout(() => emit(null, 0), 0);
    return inertHandle;
  }
  if (stopped) {
    teardown();
    return inertHandle;
  }

  // --- running state ---
  const buf: Sample[] = [];
  let lastFrameAt = 0;
  let lastEmitAt = 0;
  let lastTimestamp = 0;
  let ema: number | null = null;
  let lastGoodAt = 0;
  let consecutiveDetectErrors = 0;
  let detectionDisabled = false;

  const pushSample = (t: number, y: number, vis: number) => {
    buf.push({ t, y, vis });
    const cutoff = t - WINDOW_MS;
    let drop = 0;
    while (drop < buf.length && buf[drop].t < cutoff) drop++;
    if (drop > 0) buf.splice(0, drop);
  };

  const tick = () => {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
    lastFrameAt = now;

    // Video not ready (still negotiating, backgrounded tab, track ended).
    const ready = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;

    if (ready && landmarker && !detectionDisabled) {
      // MediaPipe VIDEO mode demands strictly increasing timestamps.
      const ts = Math.max(lastTimestamp + 1, Math.round(now));
      lastTimestamp = ts;
      try {
        const result = landmarker.detectForVideo(video, ts);
        const lm = result && result.landmarks && result.landmarks[0];
        if (lm && lm.length > 16) {
          const left = lm[15];
          const right = lm[16];
          const vL = typeof left?.visibility === 'number' ? left.visibility : 0;
          const vR = typeof right?.visibility === 'number' ? right.visibility : 0;
          const best = Math.max(vL, vR);
          if (best >= WRIST_VIS_MIN) {
            const wSum = vL + vR;
            const y = wSum > 0 ? (left.y * vL + right.y * vR) / wSum : (left.y + right.y) / 2;
            pushSample(now, y, best);
          } else {
            pushSample(now, NaN, best);
          }
        } else {
          pushSample(now, NaN, 0);
        }
        consecutiveDetectErrors = 0;
      } catch {
        consecutiveDetectErrors++;
        // Context lost / model wedged: stop burning frames, degrade to null.
        if (consecutiveDetectErrors >= 30) detectionDisabled = true;
        pushSample(now, NaN, 0);
      }
    } else {
      pushSample(now, NaN, 0);
    }

    if (now - lastEmitAt < EMIT_INTERVAL_MS) return;
    lastEmitAt = now;

    if (detectionDisabled) {
      emit(null, 0);
      return;
    }

    const { bpm, quality } = analyse(buf);
    if (bpm == null) {
      if (ema != null && now - lastGoodAt > EMA_RESET_MS) ema = null;
      emit(null, quality);
      return;
    }
    ema = ema == null ? bpm : ema + EMA_ALPHA * (bpm - ema);
    lastGoodAt = now;
    emit(Math.round(ema * 10) / 10, quality);
  };

  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      teardown();
    },
  };
}
