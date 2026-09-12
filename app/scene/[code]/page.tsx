'use client';

// ---------------------------------------------------------------------------
// app/scene/[code]/page.tsx
//
// The scene. Every phone in the room lands here, and what this file decides is
// which of two very different screens that phone is:
//
//   HOST      the commander console. Owns authoritative state, runs the
//             reasoning hop, shows the QR, and speaks to the whole room.
//   RESPONDER one job, one colour, one spoken line. Nothing else on screen.
//
// State ownership is deliberately lopsided. The host runs the reducer and
// broadcasts snapshots; responders apply actions optimistically and then adopt
// whatever the host says. That keeps the roster consistent without a server,
// and it means a responder whose websocket dies still has a usable card.
//
// Nothing here may block on the network. Realtime, K2 and Grok voice can each
// be absent and this page still runs — that is the whole degradation story.
// ---------------------------------------------------------------------------

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  Assignment,
  CommanderPlan,
  Participant,
  RoleId,
  SceneState,
} from '@/lib/types';
import { ROLE_COLOR, ROLE_LABEL } from '@/lib/types';
import { createScene, elapsed, fmtClock, reduce, type SceneAction } from '@/lib/scene';
import { activeParticipants, deterministicPlan } from '@/lib/roles';
import { joinChannel, type RealtimeHandle } from '@/lib/realtime';
import { initVoice, setVoiceEnabled, speak, voiceEnabled, voiceMode } from '@/lib/voice';
import { aedRoute, type AedRoute } from '@/lib/aed';

import StatusBar from '@/components/StatusBar';
import ResponderCard from '@/components/ResponderCard';
import CompressionCoach from '@/components/CompressionCoach';
import HandoffCard from '@/components/HandoffCard';
import JoinQR from '@/components/JoinQR';

const DEVICE_ID_KEY = 'threshold:id';

/** How often every phone tells the host it is still holding a job. */
const HEARTBEAT_MS = 4000;

/**
 * A phone silent for this long is treated as gone and its job is backfilled.
 * Two missed heartbeats. Deliberately short: a rescuer who wandered off with
 * the AED job still unfilled is the failure this whole system exists to catch,
 * and a phone that comes back simply re-joins on its next beat.
 */
const STALE_MS = 9000;

/** Host-side replan debounce. Long enough to coalesce a burst of joins. */
const REPLAN_DEBOUNCE_MS = 450;

/**
 * Client ceiling on the reasoning hop. Must sit above the server's own
 * IFM_BUDGET_MS (16s, which covers up to three attempts) or this abort fires
 * first and throws away answers the server was about to return.
 */
const PLAN_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function randomUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ensureDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length > 0) return existing;
  } catch {
    /* storage blocked */
  }
  const id = randomUuid();
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* ephemeral id is fine */
  }
  return id;
}

function normalizeCode(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

/** Host flag survives a refresh, so reloading the console does not orphan the scene. */
function hostKey(code: string): string {
  return `threshold:host:${code}`;
}

function readHostFlag(code: string): boolean {
  try {
    return window.localStorage.getItem(hostKey(code)) === '1';
  } catch {
    return false;
  }
}

function writeHostFlag(code: string): void {
  try {
    window.localStorage.setItem(hostKey(code), '1');
  } catch {
    /* nothing to do */
  }
}

function joinUrl(code: string): string {
  if (typeof window === 'undefined') return `/scene/${code}`;
  return `${window.location.origin}/scene/${code}`;
}

function findSelf(state: SceneState | null, id: string): Participant | null {
  if (!state) return null;
  return state.participants.find((p) => p.id === id) || null;
}

/**
 * Seconds the current compressor has been on the chest. The commander's
 * fatigue rule (relieve before ~2 minutes) is driven entirely by this number,
 * so it is derived from the event log rather than tracked separately.
 */
function chestSeconds(state: SceneState | null, nowMs: number): number {
  if (!state) return 0;
  const evs = state.events;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === 'compressions_stop') return 0;
    if (e.kind === 'compressions_start') {
      return Math.max(0, Math.round((elapsed(state, nowMs) - e.t) / 1000));
    }
  }
  return 0;
}

/**
 * What a replan actually depends on. Anything not in here (a bpm sample, a
 * heartbeat) must not cost a round trip, or the model is called every second.
 */
function planSignature(state: SceneState | null, chestSec: number): string {
  if (!state) return '';
  const roster = state.participants
    .map((p) => `${p.id}:${p.role}:${p.status}:${p.trained ? 't' : 'f'}`)
    .sort()
    .join('|');
  // Bucketed so fatigue crosses the threshold exactly once instead of every tick.
  const fatigue = chestSec > 110 ? 'tired' : chestSec > 60 ? 'warm' : 'fresh';
  return `${roster}#${state.aedStatus}#${fatigue}#${state.online ? 'on' : 'off'}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ScenePage({ params }: { params: Promise<{ code: string }> }) {
  const routeParams = use(params);
  const code = normalizeCode(routeParams.code);
  const router = useRouter();

  const [selfId, setSelfId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [ready, setReady] = useState(false);

  const [state, setState] = useState<SceneState | null>(null);
  const [plan, setPlan] = useState<CommanderPlan | null>(null);
  const [rtStatus, setRtStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [liveRate, setLiveRate] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [aed, setAed] = useState<AedRoute | null>(null);
  const [planning, setPlanning] = useState(false);

  const rtRef = useRef<RealtimeHandle | null>(null);
  const stateRef = useRef<SceneState | null>(null);
  const isHostRef = useRef(false);
  const replanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSignature = useRef<string>('');
  const spokenRef = useRef<string>('');
  const announcedRef = useRef<string>('');

  stateRef.current = state;
  isHostRef.current = isHost;

  // -- identity ------------------------------------------------------------
  useEffect(() => {
    if (!code || code.length !== 4) {
      router.replace('/');
      return;
    }
    const id = ensureDeviceId();
    let host = false;
    try {
      host = new URLSearchParams(window.location.search).get('host') === '1';
    } catch {
      host = false;
    }
    if (host) writeHostFlag(code);
    else host = readHostFlag(code);

    setSelfId(id);
    setIsHost(host);
    setMuted(!voiceEnabled());
    setReady(true);
    void initVoice();
  }, [code, router]);

  // -- authoritative local state ------------------------------------------
  //
  // The host seeds a real scene. A responder starts from an empty shell so its
  // card renders instantly; the host's first snapshot overwrites it wholesale.
  useEffect(() => {
    if (!ready || !selfId) return;
    setState((prev) => {
      if (prev) return prev;
      const now = Date.now();
      if (isHost) return createScene(code, selfId, now);
      const shell = createScene(code, '', now);
      return reduce(
        shell,
        { type: 'join', p: { id: selfId, name: 'You', trained: false, isHost: false } },
        now,
      );
    });
  }, [ready, selfId, isHost, code]);

  /** Apply an action locally and put it on the wire. The only way state moves. */
  const dispatch = useCallback((action: SceneAction, localOnly = false) => {
    const now = Date.now();
    setState((prev) => (prev ? reduce(prev, action, now) : prev));
    if (!localOnly) {
      try {
        rtRef.current?.send(action);
      } catch {
        /* transport is allowed to be dead */
      }
    }
  }, []);

  // -- transport -----------------------------------------------------------
  useEffect(() => {
    if (!ready || !selfId || !code) return;

    const handle = joinChannel(code, selfId, {
      name: isHost ? 'Responder 1' : 'Responder',
      trained: false,
      isHost,
    });
    rtRef.current = handle;

    handle.onAction((action) => {
      // A responder adopts the plan itself, not just the role the snapshot
      // carries. The assignment object is where the spoken line lives, and a
      // phone that has a role but no line is a phone that stays silent —
      // which is the one failure this product cannot have.
      if (action.type === 'apply_plan' && action.plan) {
        setPlan(action.plan);
      }
      // The host is the reducer of record; a responder echoing its own action
      // back into itself would double-apply the join.
      if (!isHostRef.current && action.type !== 'apply_plan') return;
      setState((prev) => (prev ? reduce(prev, action, Date.now()) : prev));
    });

    handle.onState((snapshot) => {
      if (isHostRef.current) return; // the host never takes orders about its own state
      setState(snapshot);
    });

    const poll = setInterval(() => setRtStatus(handle.getStatus()), 700);

    // Announce ourselves. The host reduces this into a participant.
    handle.send({
      type: 'join',
      p: {
        id: selfId,
        name: isHost ? 'Responder 1' : 'Responder',
        trained: false,
        isHost,
      },
    });

    const beat = setInterval(() => {
      handle.send({ type: 'heartbeat', id: selfId });
    }, HEARTBEAT_MS);

    const bye = () => {
      try {
        handle.send({ type: 'leave', id: selfId });
        handle.leave();
      } catch {
        /* closing anyway */
      }
    };
    window.addEventListener('pagehide', bye);

    return () => {
      window.removeEventListener('pagehide', bye);
      clearInterval(poll);
      clearInterval(beat);
      bye();
      rtRef.current = null;
    };
  }, [ready, selfId, code, isHost]);

  // -- host: broadcast authoritative snapshots ----------------------------
  useEffect(() => {
    if (!isHost || !state) return;
    try {
      rtRef.current?.broadcastState(state);
    } catch {
      /* transport is allowed to be dead */
    }
  }, [isHost, state]);

  // -- host: reap phones that stopped reporting ---------------------------
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => {
      const s = stateRef.current;
      if (!s) return;
      const now = Date.now();
      const rel = elapsed(s, now);
      for (const p of s.participants) {
        if (p.id === selfId || p.status === 'left') continue;
        if (rel - p.lastSeen > STALE_MS) {
          dispatch({ type: 'leave', id: p.id });
        }
      }
    }, 1500);
    return () => clearInterval(t);
  }, [isHost, selfId, dispatch]);

  // -- host: allocation in two stages -------------------------------------
  //
  // Nobody waits on a model to be told to start compressions.
  //
  // Stage one is deterministicPlan(), computed here on the device in well under
  // a millisecond and applied immediately, so every phone in the ring has a job
  // before anyone has finished reading their screen. Stage two is K2 Horizon,
  // which lands several seconds later and replaces that plan with a better
  // reasoned one. Measured against the live endpoint, the model needs six to
  // thirteen seconds; those are seconds the room spends working, not waiting.
  //
  // The model is therefore never on the critical path. It improves an
  // allocation that already exists, and if it never answers, nothing is missing
  // except the better reasoning.
  const planSeq = useRef(0);

  const requestPlan = useCallback(async () => {
    const s = stateRef.current;
    if (!s) return;

    const seq = ++planSeq.current;

    // Stage one, synchronous.
    const floor = deterministicPlan(s);
    setPlan(floor);
    dispatch({ type: 'apply_plan', plan: floor });

    setPlanning(true);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PLAN_TIMEOUT_MS);
    try {
      const res = await fetch('/api/commander', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: s, chestSeconds: chestSeconds(s, Date.now()) }),
        signal: ac.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`commander ${res.status}`);
      const next = (await res.json()) as CommanderPlan;

      // A reply for a scene that has already moved on is worse than no reply:
      // it would reassign people against a roster that no longer exists.
      if (seq !== planSeq.current) return;
      if (!next || !Array.isArray(next.assignments) || next.assignments.length === 0) return;
      // The route answers with its own deterministic fallback when the model
      // could not be reached. That is exactly what is already applied.
      if (next.degraded) return;

      setPlan(next);
      dispatch({ type: 'apply_plan', plan: next });
    } catch {
      // Timed out or the network is gone. Stage one is already in force.
    } finally {
      clearTimeout(timer);
      if (seq === planSeq.current) setPlanning(false);
    }
  }, [dispatch]);

  // Fires only when the allocation problem actually changed. See planSignature.
  useEffect(() => {
    if (!isHost || !state) return;
    const sig = planSignature(state, chestSeconds(state, Date.now()));
    if (!sig || sig === lastSignature.current) return;
    lastSignature.current = sig;

    if (replanTimer.current) clearTimeout(replanTimer.current);
    replanTimer.current = setTimeout(() => {
      void requestPlan();
    }, REPLAN_DEBOUNCE_MS);

    return () => {
      if (replanTimer.current) clearTimeout(replanTimer.current);
    };
  }, [isHost, state, requestPlan]);

  // Fatigue is a clock, not an event: poke the signature check every 5s so the
  // 110-second relief actually fires while nobody is touching the screen.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [isHost]);

  // -- my assignment -------------------------------------------------------
  const self = useMemo(() => findSelf(state, selfId), [state, selfId]);

  const myAssignment: Assignment | null = useMemo(() => {
    if (!plan || !selfId) return null;
    return plan.assignments.find((a) => a.participantId === selfId) || null;
  }, [plan, selfId]);

  // A non-host learns its assignment from the role the host wrote into the
  // snapshot, since plan objects are not part of SceneState.
  const myRole: RoleId = (myAssignment?.role || self?.role || 'unassigned') as RoleId;

  // -- speak my own line, once --------------------------------------------
  useEffect(() => {
    const line = myAssignment?.spoken;
    if (!line) return;
    const stamp = `${myRole}:${line}`;
    if (stamp === spokenRef.current) return;
    spokenRef.current = stamp;
    speak(line, { urgency: myAssignment?.urgency === 'now' ? 'now' : 'soon' });
  }, [myAssignment, myRole]);

  // -- host only: shout the room announcement -----------------------------
  useEffect(() => {
    if (!isHost) return;
    const line = plan?.roomAnnouncement;
    if (!line) return;
    if (line === announcedRef.current) return;
    announcedRef.current = line;
    speak(line, { urgency: 'now' });
  }, [isHost, plan]);

  // -- AED runner gets a destination --------------------------------------
  useEffect(() => {
    if (myRole !== 'aed') {
      setAed(null);
      return;
    }
    let dead = false;
    const fallback: [number, number] = [-79.9436, 40.4432];
    const go = (from: [number, number]) => {
      aedRoute(from)
        .then((r) => {
          if (!dead) setAed(r);
        })
        .catch(() => undefined);
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => go([pos.coords.longitude, pos.coords.latitude]),
        () => go(fallback),
        { timeout: 4000, maximumAge: 60000 },
      );
    } catch {
      go(fallback);
    }
    return () => {
      dead = true;
    };
  }, [myRole]);

  // -- rate from the camera ------------------------------------------------
  const onRate = useCallback(
    (bpm: number | null) => {
      setLiveRate(bpm);
      dispatch({ type: 'rate', bpm });
    },
    [dispatch],
  );

  // -- controls ------------------------------------------------------------
  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    setVoiceEnabled(!next);
    if (!next) speak('Voice on.', { urgency: 'soon' });
  }, [muted]);

  const toggleOnline = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    dispatch({ type: 'online', online: !s.online });
  }, [dispatch]);

  /**
   * The rescuer is failing. This is the demo's sharpest beat and the reason the
   * commander has a fatigue rule at all: one tap flips this phone to
   * 'struggling', which changes the plan signature, which forces a replan that
   * must take them off the chest. Nothing else on this screen triggers a
   * reallocation this directly.
   */
  const swapOut = useCallback(() => {
    dispatch({ type: 'struggle', id: selfId, struggling: true });
  }, [dispatch, selfId]);

  const setAedStatus = useCallback(
    (status: SceneState['aedStatus']) => {
      dispatch({ type: 'aed', status });
    },
    [dispatch],
  );

  // ------------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------------

  if (!ready || !state) {
    return (
      <main className="wrap">
        <div className="panel">
          <div className="label">Threshold</div>
          <p className="dim">Opening scene {code}…</p>
        </div>
      </main>
    );
  }

  const roster = activeParticipants(state);

  // ---- RESPONDER ---------------------------------------------------------
  if (!isHost) {
    return (
      <main className="wrap">
        <StatusBar
          state={state}
          selfId={selfId}
          rtStatus={rtStatus}
          planModel={plan?.model ?? null}
          degraded={!!plan?.degraded}
        />

        <ResponderCard
          participant={self}
          assignment={myAssignment}
          state={state}
          liveRate={liveRate}
          onSwapOut={myRole === 'compressions' ? swapOut : undefined}
        />

        {myRole === 'compressions' ? (
          <CompressionCoach active onRate={onRate} />
        ) : null}

        {myRole === 'aed' && aed ? (
          <div className="panel">
            <div className="label">Nearest AED</div>
            <div className="big">{aed.name}</div>
            <div className="row row-between">
              <span className="mono">{aed.distanceM} m</span>
              <span className="mono">{Math.round(aed.etaSec)} s away</span>
            </div>
            <ul className="stack">
              {aed.steps.map((s, i) => (
                <li key={i} className="dim">
                  {s}
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn" onClick={() => setAedStatus('onscene')}>
                AED is here
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAedStatus('attached')}
              >
                Pads attached
              </button>
            </div>
          </div>
        ) : null}

        <div className="row row-between">
          <button type="button" className="btn btn-ghost" onClick={toggleMute}>
            {muted ? 'Unmute voice' : 'Mute voice'}
          </button>
          <span className="dim mono">{voiceMode()}</span>
        </div>

        <p className="foot">
          Simulation for demonstration only. No medical advice. In a real emergency call 911.
        </p>
      </main>
    );
  }

  // ---- HOST / COMMANDER CONSOLE -----------------------------------------
  return (
    <main className="wrap wrap-wide">
      <StatusBar
        state={state}
        selfId={selfId}
        rtStatus={rtStatus}
        planModel={plan?.model ?? null}
        degraded={!!plan?.degraded}
      />

      {!state.online ? (
        <div className="banner banner-warn">
          Network down. Reasoning locally — compressions keep their beat.
        </div>
      ) : null}
      {rtStatus === 'offline' ? (
        <div className="banner">
          Single-device mode: no transport reached. Other phones cannot join this scene.
        </div>
      ) : null}

      <div className="panel qr-block">
        <div className="label">Anyone here — open this</div>
        <div className="big mono">{code}</div>
        <JoinQR url={joinUrl(code)} />
        <p className="dim">{joinUrl(code)}</p>
      </div>

      <div className="panel">
        <div className="row row-between">
          <span className="label">Scene</span>
          <span className="mono clock">{fmtClock(elapsed(state, Date.now()))}</span>
        </div>
        <div className="stack">
          {roster.length === 0 ? (
            <p className="dim">Nobody has joined yet. You are the only pair of hands.</p>
          ) : (
            roster.map((p) => {
              const a = plan?.assignments.find((x) => x.participantId === p.id) || null;
              const role = (a?.role || p.role) as RoleId;
              return (
                <div key={p.id} className="row role-bar">
                  <span
                    className="role-edge"
                    style={{ background: ROLE_COLOR[role] }}
                    aria-hidden="true"
                  />
                  <span className="role-text">
                    <strong>{p.name}</strong>
                    {p.id === selfId ? ' (you)' : ''}
                    {p.status === 'struggling' ? ' · struggling' : ''}
                  </span>
                  <span className="mono dim">{ROLE_LABEL[role]}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="panel">
        <div className="row row-between">
          <span className="label">Commander reasoning</span>
          <span className="mono dim">
            {planning
              ? 'K2 thinking…'
              : plan
                ? `${plan.latencyMs} ms${plan.degraded ? ' · on-device' : ''}`
                : '—'}
          </span>
        </div>
        <p>{plan?.reasoning || 'Waiting for the first allocation.'}</p>
        {plan ? (
          <div className="row row-between">
            <span className="mono dim">{plan.model}</span>
            <span className="mono dim">{plan.degraded ? 'degraded' : 'live'}</span>
          </div>
        ) : null}
      </div>

      {myRole === 'compressions' ? <CompressionCoach active onRate={onRate} /> : null}

      <div className="panel panel-tight">
        <div className="label">Scene controls</div>
        <div className="row">
          <button type="button" className="btn" onClick={() => setAedStatus('enroute')}>
            AED en route
          </button>
          <button type="button" className="btn" onClick={() => setAedStatus('attached')}>
            AED attached
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              dispatch({ type: 'event', ev: { kind: 'shock', detail: 'Shock delivered' } })
            }
          >
            Shock
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              dispatch({ type: 'event', ev: { kind: 'ems_arrive', detail: 'EMS on scene' } })
            }
          >
            EMS arrived
          </button>
        </div>
        <div className="row row-between">
          <button type="button" className="btn btn-ghost" onClick={toggleMute}>
            {muted ? 'Unmute voice' : 'Mute voice'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={toggleOnline}>
            {state.online ? 'Simulate network loss' : 'Restore network'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowHandoff((v) => !v)}
          >
            {showHandoff ? 'Hide handoff' : 'EMS handoff'}
          </button>
        </div>
      </div>

      {showHandoff ? <HandoffCard state={state} /> : null}

      <p className="foot">
        Simulation for demonstration only. No medical advice. In a real emergency call 911.
      </p>
    </main>
  );
}
