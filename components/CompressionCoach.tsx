'use client';

// ---------------------------------------------------------------------------
// Threshold — the screen the person doing compressions sees.
//
// The audible metronome is the primary coaching channel and runs entirely
// locally the moment this component goes active. The camera is confirmation:
// it can fail, be denied, or see nothing at all and this screen still does its
// job. No network call sits between the responder and the beat.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { startCompressionTracking, type VisionHandle } from '@/lib/cpr-vision';
import { startMetronome, stopMetronome } from '@/lib/metronome';

interface CompressionCoachProps {
  active: boolean;
  onRate: (bpm: number | null) => void;
}

type CamState = 'idle' | 'starting' | 'live' | 'denied' | 'unavailable';
type VisionState = 'off' | 'warming' | 'tracking' | 'unavailable';

const TARGET_BPM = 110;
const BAND_LOW = 100;
const BAND_HIGH = 120;
const GAUGE_MIN = 60;
const GAUGE_MAX = 160;
/** Below this we say "can't see hands" instead of showing a number. */
const QUALITY_FLOOR = 0.35;
/** A reading older than this is not live any more — never render it as if it were. */
const STALE_MS = 1600;
/** Coaching text may not change faster than this. Flicker is the enemy. */
const COACH_MIN_INTERVAL_MS = 2000;
/** The failure path of startCompressionTracking emits exactly once. */
const VISION_PROBE_MS = 4500;

const GREEN = '#30d158';
const AMBER = '#ff9f0a';
const RED = '#ff3b30';
const GREY = '#8e8e93';

function rateColor(bpm: number | null): string {
  if (bpm == null) return GREY;
  if (bpm >= BAND_LOW && bpm <= BAND_HIGH) return GREEN;
  if (bpm >= BAND_LOW - 10 && bpm <= BAND_HIGH + 10) return AMBER;
  return RED;
}

function gaugePercent(bpm: number): number {
  const pct = ((bpm - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100;
  return Math.max(0, Math.min(100, pct));
}

const CSS = `
.cc-root{
  display:flex;flex-direction:column;gap:10px;
  width:100%;max-width:560px;margin:0 auto;
  color:#f5f5f7;background:#0a0a0b;
  -webkit-tap-highlight-color:transparent;
}
.cc-sim{
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  border:1px solid rgba(255,159,10,.5);background:rgba(255,159,10,.09);
  color:#ff9f0a;border-radius:4px;padding:8px 10px;
  font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
}
.cc-sim b{color:#f5f5f7;font-weight:700;letter-spacing:.14em;}

.cc-stage{
  position:relative;width:100%;aspect-ratio:3/4;max-height:48vh;
  background:#000;border:1px solid #1e1e21;border-radius:4px;overflow:hidden;
}
@media(min-width:700px){ .cc-stage{aspect-ratio:16/10;max-height:none;} }
.cc-video{
  position:absolute;inset:0;width:100%;height:100%;
  object-fit:cover;display:block;background:#000;
}
.cc-video.cc-hidden{opacity:0;}
.cc-veil{
  position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,rgba(10,10,11,.72) 0%,rgba(10,10,11,0) 32%,rgba(10,10,11,0) 46%,rgba(10,10,11,.88) 100%);
}
.cc-tag{
  position:absolute;top:10px;left:10px;z-index:2;
  font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;
  padding:5px 8px;border-radius:3px;border:1px solid rgba(245,245,247,.22);
  background:rgba(10,10,11,.66);color:#c7c7cc;
}
.cc-readout{
  position:absolute;left:0;right:0;bottom:0;z-index:2;
  display:flex;flex-direction:column;align-items:center;
  padding:0 12px 14px;text-align:center;
}
.cc-bpm{
  font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  font-size:clamp(76px,25vw,132px);line-height:.92;font-weight:700;
  letter-spacing:-.03em;font-variant-numeric:tabular-nums;
  text-shadow:0 2px 22px rgba(0,0,0,.85);
}
.cc-unit{
  margin-top:6px;font-size:11px;font-weight:700;letter-spacing:.2em;
  text-transform:uppercase;color:#c7c7cc;
}
.cc-noread{
  font-size:clamp(17px,4.6vw,22px);font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;color:#ff9f0a;line-height:1.25;
  text-shadow:0 2px 18px rgba(0,0,0,.9);padding-bottom:4px;
}
.cc-pulse{
  position:absolute;top:10px;right:10px;z-index:2;
  width:14px;height:14px;border-radius:50%;background:#ff3b30;
}
.cc-pulse.cc-beating{animation:cc-beat 545ms ease-out infinite;}
@keyframes cc-beat{
  0%{transform:scale(1);opacity:1;box-shadow:0 0 0 0 rgba(255,59,48,.55);}
  70%{transform:scale(.82);opacity:.75;box-shadow:0 0 0 14px rgba(255,59,48,0);}
  100%{transform:scale(1);opacity:1;box-shadow:0 0 0 0 rgba(255,59,48,0);}
}
@media(prefers-reduced-motion:reduce){ .cc-pulse.cc-beating{animation:none;} }

.cc-cover{
  position:absolute;inset:0;z-index:3;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:14px;padding:22px;text-align:center;background:rgba(10,10,11,.93);
}
.cc-cover h3{
  margin:0;font-size:15px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:#f5f5f7;
}
.cc-cover p{margin:0;font-size:13px;line-height:1.5;color:#98989d;max-width:34ch;}

.cc-btn{
  display:block;width:100%;min-height:56px;padding:16px 18px;
  border:1px solid #48484a;border-radius:4px;background:#1c1c1e;color:#f5f5f7;
  font-size:15px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
  font-family:inherit;cursor:pointer;
}
.cc-btn:active{background:#2c2c2e;}
.cc-btn.cc-primary{background:#ff3b30;border-color:#ff3b30;color:#0a0a0b;}
.cc-btn.cc-primary:active{background:#d92c22;border-color:#d92c22;}
.cc-btn[disabled]{opacity:.5;cursor:default;}
.cc-cover .cc-btn{max-width:300px;}

.cc-gauge{padding:2px 2px 0;}
.cc-track{
  position:relative;height:26px;border-radius:3px;overflow:hidden;
  background:#151517;border:1px solid #1e1e21;
}
.cc-zone{
  position:absolute;top:0;bottom:0;left:40%;width:20%;
  background:rgba(48,209,88,.20);border-left:1px solid rgba(48,209,88,.65);
  border-right:1px solid rgba(48,209,88,.65);
}
.cc-needle{
  position:absolute;top:-2px;bottom:-2px;width:4px;margin-left:-2px;border-radius:2px;
  transition:left 220ms linear,background-color 220ms linear;
}
.cc-ticks{
  display:flex;justify-content:space-between;margin-top:5px;
  font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace;
  font-size:10px;letter-spacing:.08em;color:#6e6e73;
}
.cc-ticks span.cc-target{color:#30d158;}

.cc-coach{
  min-height:58px;display:flex;align-items:center;justify-content:center;
  border:1px solid #1e1e21;border-radius:4px;background:#151517;
  padding:14px 12px;text-align:center;
  font-size:clamp(18px,5.2vw,26px);font-weight:700;letter-spacing:.1em;
  text-transform:uppercase;line-height:1.15;
}
.cc-foot{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  font-size:10px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:#6e6e73;min-height:20px;
}
.cc-foot .cc-on{color:#30d158;}
.cc-foot .cc-warn{color:#ff9f0a;}
.cc-link{
  background:none;border:none;padding:6px 0;margin:0;color:#0a84ff;
  font:inherit;font-size:10px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;cursor:pointer;
}
`;

export default function CompressionCoach({ active, onRate }: CompressionCoachProps) {
  const [camState, setCamState] = useState<CamState>('idle');
  const [visionState, setVisionState] = useState<VisionState>('off');
  const [camNote, setCamNote] = useState<string>('');
  const [bpm, setBpm] = useState<number | null>(null);
  const [quality, setQuality] = useState<number>(0);
  const [coach, setCoach] = useState<string>('FOLLOW THE BEAT');
  const [metronomeOn, setMetronomeOn] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const visionRef = useRef<VisionHandle | null>(null);
  const onRateRef = useRef(onRate);
  const lastSentRef = useRef<number | null | undefined>(undefined);
  const lastRateAtRef = useRef<number>(0);
  const coachAtRef = useRef<number>(0);
  const coachTextRef = useRef<string>('FOLLOW THE BEAT');
  const rateCallsRef = useRef<number>(0);
  const probeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    onRateRef.current = onRate;
  }, [onRate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // --- push rate upward, only on change ------------------------------------
  const publish = useCallback((value: number | null) => {
    if (lastSentRef.current === value) return;
    lastSentRef.current = value;
    try {
      onRateRef.current(value);
    } catch {
      /* parent errors must not break the coach */
    }
  }, []);

  // --- coaching text, throttled --------------------------------------------
  const setCoachThrottled = useCallback((text: string, force?: boolean) => {
    if (text === coachTextRef.current) return;
    const now = Date.now();
    if (!force && now - coachAtRef.current < COACH_MIN_INTERVAL_MS) return;
    coachAtRef.current = now;
    coachTextRef.current = text;
    setCoach(text);
  }, []);

  const coachFor = useCallback((value: number | null, q: number, cam: CamState, vis: VisionState) => {
    if (cam !== 'live' || vis === 'unavailable') return 'FOLLOW THE BEAT';
    if (vis === 'warming') return 'HOLD STEADY — READING';
    if (value == null || q < QUALITY_FLOOR) return "CAN'T SEE HANDS — KEEP GOING";
    if (value < BAND_LOW) return 'FASTER';
    if (value > BAND_HIGH) return 'SLOWER';
    return 'GOOD RATE — KEEP GOING';
  }, []);

  // --- metronome: local, deterministic, always on while active -------------
  useEffect(() => {
    if (!active) {
      try {
        stopMetronome();
      } catch {
        /* audio unavailable */
      }
      setMetronomeOn(false);
      return;
    }
    let ok = false;
    try {
      startMetronome(TARGET_BPM);
      ok = true;
    } catch {
      ok = false;
    }
    setMetronomeOn(ok);
    return () => {
      try {
        stopMetronome();
      } catch {
        /* audio unavailable */
      }
    };
  }, [active]);

  // --- teardown -------------------------------------------------------------
  const stopEverything = useCallback(() => {
    if (probeRef.current) {
      clearTimeout(probeRef.current);
      probeRef.current = null;
    }
    try {
      visionRef.current?.stop();
    } catch {
      /* already stopped */
    }
    visionRef.current = null;
    const stream = streamRef.current;
    if (stream) {
      try {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* already stopped */
          }
        });
      } catch {
        /* nothing to stop */
      }
    }
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      try {
        v.srcObject = null;
      } catch {
        /* detached */
      }
    }
    rateCallsRef.current = 0;
    setBpm(null);
    setQuality(0);
    publish(null);
  }, [publish]);

  // --- camera + vision start (must follow a user gesture) -------------------
  const startCamera = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (camState === 'starting' || camState === 'live') return;

    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      setCamState('unavailable');
      setCamNote(
        'This browser will not hand over a camera here. Cameras need a secure (https) address. The beat still works.',
      );
      return;
    }

    setCamState('starting');
    setCamNote('');
    setVisionState('warming');

    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch (err: any) {
      const name = err && err.name ? String(err.name) : '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        setCamState('denied');
        setCamNote('No camera access. Nothing is wrong on your end — keep going with the beat.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        setCamState('unavailable');
        setCamNote('No camera found on this device. Keep going with the beat.');
      } else {
        setCamState('unavailable');
        setCamNote('The camera did not start. Keep going with the beat.');
      }
      setVisionState('off');
      return;
    }

    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      });
      return;
    }

    streamRef.current = stream;
    const v = videoRef.current;
    if (!v) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      });
      streamRef.current = null;
      setCamState('unavailable');
      setCamNote('The preview could not attach. Keep going with the beat.');
      setVisionState('off');
      return;
    }

    try {
      v.srcObject = stream;
      v.muted = true;
      const p = v.play();
      if (p && typeof p.then === 'function') await p.catch(() => undefined);
    } catch {
      /* iOS occasionally rejects play(); the stream still renders */
    }

    setCamState('live');
    rateCallsRef.current = 0;
    lastRateAtRef.current = Date.now();

    let handle: VisionHandle;
    try {
      handle = await startCompressionTracking(v, (value, q) => {
        if (!mountedRef.current) return;
        rateCallsRef.current += 1;
        lastRateAtRef.current = Date.now();
        setBpm(value);
        setQuality(q);
        publish(value == null ? null : Math.round(value));
      });
    } catch {
      // startCompressionTracking is contracted never to throw; belt and braces.
      setVisionState('unavailable');
      return;
    }

    if (!mountedRef.current) {
      try {
        handle.stop();
      } catch {
        /* already stopped */
      }
      return;
    }
    visionRef.current = handle;

    // The failure path calls back exactly once. A live tracker calls back at 4Hz.
    if (probeRef.current) clearTimeout(probeRef.current);
    probeRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (rateCallsRef.current <= 1) {
        setVisionState('unavailable');
        setBpm(null);
        setQuality(0);
        publish(null);
      } else {
        setVisionState('tracking');
      }
    }, VISION_PROBE_MS);
  }, [camState, publish]);

  // --- stop camera when the role goes inactive, and on unmount --------------
  useEffect(() => {
    if (!active) {
      stopEverything();
      setCamState('idle');
      setVisionState('off');
      setCamNote('');
    }
  }, [active, stopEverything]);

  useEffect(() => {
    return () => {
      if (probeRef.current) clearTimeout(probeRef.current);
      try {
        visionRef.current?.stop();
      } catch {
        /* already stopped */
      }
      visionRef.current = null;
      const stream = streamRef.current;
      if (stream) {
        try {
          stream.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* already stopped */
            }
          });
        } catch {
          /* nothing to stop */
        }
      }
      streamRef.current = null;
      try {
        stopMetronome();
      } catch {
        /* audio unavailable */
      }
    };
  }, []);

  // --- staleness: never render an old number as if it were live -------------
  useEffect(() => {
    if (camState !== 'live') return;
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      if (Date.now() - lastRateAtRef.current > STALE_MS) {
        setBpm((prev) => (prev == null ? prev : null));
        setQuality(0);
        publish(null);
      }
    }, 500);
    return () => clearInterval(id);
  }, [camState, publish]);

  // --- coaching line --------------------------------------------------------
  useEffect(() => {
    const want = coachFor(bpm, quality, camState, visionState);
    setCoachThrottled(want, coachTextRef.current === want ? false : coachAtRef.current === 0);
  }, [bpm, quality, camState, visionState, coachFor, setCoachThrottled]);

  useEffect(() => {
    // Guarantees the throttled line eventually catches up even if updates stop.
    const id = setInterval(() => {
      if (!mountedRef.current) return;
      setCoachThrottled(coachFor(bpm, quality, camState, visionState));
    }, 700);
    return () => clearInterval(id);
  }, [bpm, quality, camState, visionState, coachFor, setCoachThrottled]);

  // --- render ---------------------------------------------------------------
  const showNumber = camState === 'live' && visionState !== 'unavailable' && bpm != null && quality >= QUALITY_FLOOR;
  const colour = showNumber ? rateColor(bpm) : GREY;
  const needleLeft = showNumber && bpm != null ? gaugePercent(bpm) : 0;
  const coachColour =
    coach === 'GOOD RATE — KEEP GOING' ? GREEN : coach === 'FASTER' || coach === 'SLOWER' ? RED : AMBER;

  let coverTitle = '';
  let coverBody = '';
  let coverButton = '';
  if (!active) {
    coverTitle = 'Compressions paused';
    coverBody = 'The camera is off. It restarts when this phone is back on compressions.';
  } else if (camState === 'idle') {
    coverTitle = 'Camera rate check';
    coverBody = 'Prop the phone so it sees the hands on the chest. The beat is already playing.';
    coverButton = 'Start camera';
  } else if (camState === 'starting') {
    coverTitle = 'Starting camera';
    coverBody = 'Allow camera access when your phone asks.';
  } else if (camState === 'denied' || camState === 'unavailable') {
    coverTitle = 'No camera';
    coverBody = camNote;
    coverButton = 'Try again';
  }

  const showCover = coverTitle !== '';

  return (
    <div className="cc-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <div className="cc-sim">
        <span>Simulation</span>
        <b>Call 911</b>
      </div>

      <div className="cc-stage">
        <video
          ref={videoRef}
          className={'cc-video' + (camState === 'live' ? '' : ' cc-hidden')}
          playsInline
          muted
          autoPlay
        />
        <div className="cc-veil" />
        <div className="cc-tag">{active ? 'Compressions' : 'Standby'}</div>
        <div className={'cc-pulse' + (active ? ' cc-beating' : '')} aria-hidden="true" />

        <div className="cc-readout">
          {showNumber ? (
            <>
              <div className="cc-bpm" style={{ color: colour }}>
                {Math.round(bpm as number)}
              </div>
              <div className="cc-unit">Per minute</div>
            </>
          ) : camState === 'live' ? (
            <div className="cc-noread">
              {visionState === 'unavailable'
                ? 'Camera coach unavailable — follow the beat'
                : visionState === 'warming'
                  ? 'Reading the rate — keep going'
                  : "Can't see hands — keep going"}
            </div>
          ) : null}
        </div>

        {showCover ? (
          <div className="cc-cover">
            <h3>{coverTitle}</h3>
            {coverBody ? <p>{coverBody}</p> : null}
            {coverButton ? (
              <button
                type="button"
                className="cc-btn cc-primary"
                onClick={() => {
                  void startCamera();
                }}
                disabled={camState === 'starting'}
              >
                {coverButton}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="cc-gauge">
        <div className="cc-track">
          <div className="cc-zone" />
          {showNumber ? (
            <div className="cc-needle" style={{ left: needleLeft + '%', backgroundColor: colour }} />
          ) : null}
        </div>
        <div className="cc-ticks">
          <span>60</span>
          <span className="cc-target">100</span>
          <span className="cc-target">120</span>
          <span>160</span>
        </div>
      </div>

      <div className="cc-coach" style={{ color: coachColour, borderColor: coachColour + '55' }}>
        {coach}
      </div>

      <div className="cc-foot">
        <span className={metronomeOn ? 'cc-on' : 'cc-warn'}>
          {metronomeOn ? 'Beat ' + TARGET_BPM + '/min' : 'Beat off'}
        </span>
        {camState === 'live' ? (
          <button
            type="button"
            className="cc-link"
            onClick={() => {
              stopEverything();
              setCamState('idle');
              setVisionState('off');
            }}
          >
            Stop camera
          </button>
        ) : (
          <span>{visionState === 'unavailable' ? 'Rate check offline' : 'Camera optional'}</span>
        )}
      </div>
    </div>
  );
}
