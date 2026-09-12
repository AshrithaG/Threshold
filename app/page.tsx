'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { newSceneCode } from '@/lib/scene';

const DEVICE_ID_KEY = 'threshold:id';

/** Mirrors CODE_ALPHABET in lib/scene.ts (no I, L, O, 0 or 1). Only reached if newSceneCode throws. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

interface HealthReport {
  k2: { ok: boolean; model: string | null };
  voice: { ok: boolean; mode: 'grok-tts' | 'browser' };
  realtime: { ok: boolean; mode: 'supabase' | 'local-bus' };
  mapbox: { ok: boolean };
  localModel: { ok: boolean };
}

function randomUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Safari < 15.4 and insecure origins: build a v4-shaped id by hand.
  const bytes = new Uint8Array(16);
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable per-device identity. Private mode / blocked storage must not break start. */
function ensureDeviceId(): string {
  const id = randomUuid();
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length > 0) return existing;
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* storage unavailable — the id still works for this session */
  }
  return id;
}

function fallbackCode(): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function sanitizeCode(raw: string): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

export default function Home() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const [starting, setStarting] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthState, setHealthState] = useState<'checking' | 'ready' | 'unknown'>('checking');

  // Truthful integration readout. Never blocks the screen: 3s ceiling, then
  // everything reads "unknown" rather than pretending to be live.
  useEffect(() => {
    let dead = false;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);

    (async () => {
      try {
        const res = await fetch('/api/health', { signal: ac.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`health ${res.status}`);
        const json = (await res.json()) as HealthReport;
        if (dead) return;
        setHealth(json);
        setHealthState('ready');
      } catch {
        if (dead) return;
        setHealth(null);
        setHealthState('unknown');
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => {
      dead = true;
      clearTimeout(timer);
      ac.abort();
    };
  }, []);

  const startScene = useCallback(() => {
    if (starting) return;
    setStarting(true);
    ensureDeviceId();

    let next = '';
    try {
      next = newSceneCode(Date.now());
    } catch {
      next = '';
    }
    const clean = sanitizeCode(next);
    const sceneCode = clean.length === 4 ? clean : fallbackCode();

    router.push(`/scene/${sceneCode}?host=1`);
  }, [router, starting]);

  const joinScene = useCallback(() => {
    const clean = sanitizeCode(code);
    if (clean.length !== 4) {
      inputRef.current?.focus();
      return;
    }
    ensureDeviceId();
    router.push(`/scene/${clean}`);
  }, [code, router]);

  const activeBox = Math.min(code.length, 3);

  const integrations = [
    {
      key: 'k2',
      name: 'K2 Horizon',
      ok: !!health?.k2.ok,
      live: health?.k2.model ? `reasoning · ${health.k2.model}` : 'reasoning',
      down: 'deterministic plan',
    },
    {
      key: 'voice',
      name: 'Grok voice',
      ok: !!health?.voice.ok,
      live: 'per-phone speech',
      down: 'browser speech',
    },
    {
      key: 'realtime',
      name: 'Realtime',
      ok: !!health?.realtime.ok,
      live: health?.realtime.mode === 'supabase' ? 'multi-device · supabase' : 'multi-device · this server',
      down: 'single-device',
    },
    {
      key: 'mapbox',
      name: 'Mapbox',
      ok: !!health?.mapbox.ok,
      live: 'AED routing',
      down: 'static AED list',
    },
  ];

  return (
    <main className="wrap landing">
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Threshold</span>
        </div>
        <p className="tagline">
          AI incident command for the minutes before the ambulance arrives.
        </p>
      </header>

      <button
        type="button"
        className="btn btn-primary btn-start"
        onClick={startScene}
        disabled={starting}
      >
        {starting ? 'Starting…' : 'Start a scene'}
      </button>

      <div className="joinblock">
        <div className="label">Joining someone else&apos;s scene</div>

        <div
          className="codewrap"
          onClick={() => inputRef.current?.focus()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') inputRef.current?.focus();
          }}
        >
          <div className="codeboxes" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={
                  'codebox' +
                  (code[i] ? ' filled' : '') +
                  (focused && i === activeBox && code.length < 4 ? ' active' : '')
                }
              >
                {code[i] || ''}
              </div>
            ))}
          </div>
          <input
            ref={inputRef}
            className="codeinput mono"
            type="text"
            value={code}
            onChange={(e) => setCode(sanitizeCode(e.target.value))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                joinScene();
              }
            }}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={4}
            aria-label="Four character join code"
          />
        </div>

        <button
          type="button"
          className="btn"
          onClick={joinScene}
          disabled={code.length !== 4}
        >
          Join
        </button>
      </div>

      <div className="statusblock">
        <div className="label">Integrations</div>
        <div className="status">
          {integrations.map((it) => (
            <span key={it.key} className={'status-item' + (it.ok ? ' live' : '')}>
              <span className={'dot' + (it.ok ? ' live' : '')} aria-hidden="true" />
              <span>{it.name}</span>
              <span className="status-state">
                {healthState === 'checking'
                  ? 'checking'
                  : healthState === 'unknown'
                    ? 'unknown'
                    : it.ok
                      ? it.live
                      : it.down}
              </span>
            </span>
          ))}
          {health?.localModel.ok ? (
            <span className="status-item live">
              <span className="dot live" aria-hidden="true" />
              <span>Local model</span>
              <span className="status-state">offline fallback</span>
            </span>
          ) : null}
        </div>

        <p className="foot">
          Simulation for demonstration only. It gives no medical advice. In a real
          emergency, call 911 and follow the dispatcher.
        </p>
      </div>
    </main>
  );
}
