// ---------------------------------------------------------------------------
// Threshold — pure scene state machine.
//
// No I/O, no timers, no randomness, no browser globals. Safe to import from a
// server component, a client component, or a route handler.
//
// The event log this file builds IS the EMS handoff record. Accuracy here is
// the product: every entry is stamped in ms-since-scene-start and says who did
// what. Be thorough, but never flood it — a medic reads this in ten seconds.
// ---------------------------------------------------------------------------

import type {
  AedStatus,
  CommanderPlan,
  Participant,
  ParticipantStatus,
  RoleId,
  SceneEvent,
  SceneState,
} from '@/lib/types';
import { ROLE_LABEL } from '@/lib/types';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type SceneAction =
  | { type: 'join'; p: { id: string; name: string; trained: boolean; isHost: boolean } }
  | { type: 'leave'; id: string }
  | { type: 'heartbeat'; id: string }
  | { type: 'struggle'; id: string; struggling: boolean }
  | { type: 'apply_plan'; plan: CommanderPlan }
  | { type: 'rate'; bpm: number | null }
  | { type: 'aed'; status: AedStatus }
  | { type: 'event'; ev: Omit<SceneEvent, 't'> }
  | { type: 'online'; online: boolean }
  | { type: 'replace'; state: SceneState };

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Chest-compression target band, beats per minute. */
const RATE_MIN = 100;
const RATE_MAX = 120;

/** Ring-buffer cap for the raw rate trace (kept for the post-scene chart). */
const MAX_SAMPLES = 400;

/** Safety valve only. The band-crossing filter keeps real scenes far below this. */
const MAX_EVENTS = 4000;

/** Unambiguous over a phone, in a lobby, at 2am. No 0/O, no 1/I/L. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 4;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** ms since scene start, never negative (phones disagree about wall clock). */
function rel(s: SceneState, nowMs: number): number {
  return Math.max(0, Math.round(num(nowMs) - num(s.createdAt)));
}

function ev(
  t: number,
  kind: SceneEvent['kind'],
  detail?: string,
  actorId?: string,
  data?: Record<string, any>,
): SceneEvent {
  const e: SceneEvent = { t, kind };
  if (actorId) e.actorId = actorId;
  if (detail) e.detail = detail;
  if (data) e.data = data;
  return e;
}

/** Append events, preserving the opening entry if we ever have to trim. */
function withEvents(events: SceneEvent[], toAdd: SceneEvent[]): SceneEvent[] {
  if (toAdd.length === 0) return events;
  const next = events.concat(toAdd);
  if (next.length <= MAX_EVENTS) return next;
  return [next[0]].concat(next.slice(next.length - (MAX_EVENTS - 1)));
}

function replaceAt<T>(arr: T[], idx: number, value: T): T[] {
  const out = arr.slice();
  out[idx] = value;
  return out;
}

function nameOf(s: SceneState, id: string): string {
  const p = s.participants.find((x) => x.id === id);
  return p ? p.name : 'Someone';
}

function roleLabel(role: RoleId): string {
  return ROLE_LABEL[role] || 'STAND BY';
}

type Band = 'slow' | 'in_band' | 'fast';

function bandOf(bpm: number): Band {
  if (bpm < RATE_MIN) return 'slow';
  if (bpm > RATE_MAX) return 'fast';
  return 'in_band';
}

const BAND_TEXT: Record<Band, string> = {
  slow: `below the ${RATE_MIN}-${RATE_MAX} band`,
  in_band: `inside the ${RATE_MIN}-${RATE_MAX} band`,
  fast: `above the ${RATE_MIN}-${RATE_MAX} band`,
};

/** Last band we logged, read back out of the record so null gaps don't reset it. */
function lastLoggedBand(events: SceneEvent[]): Band | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'rate_sample' && e.data && typeof e.data.band === 'string') {
      return e.data.band as Band;
    }
  }
  return null;
}

/** True when the log currently says compressions are underway. */
function compressionsUnderway(events: SceneEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i].kind;
    if (k === 'compressions_start') return true;
    if (k === 'compressions_stop') return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Join codes
// ---------------------------------------------------------------------------

/** murmur3 finalizer — adjacent seeds produce codes that look nothing alike. */
function avalanche(v: number): number {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Deterministic 4-char join code. Callers own the entropy (Date.now(), a
 * counter, a crypto value) — this module never touches Math.random, so it
 * renders identically on the server and the client.
 */
export function newSceneCode(seedNum: number): string {
  const seed = Number.isFinite(seedNum) ? Math.floor(Math.abs(seedNum)) : 0;
  let h = avalanche((seed ^ 0x9e3779b9) >>> 0);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET.charAt(h % CODE_ALPHABET.length);
    h = avalanche((h + 0x6d2b79f5 + i) >>> 0);
  }
  return out;
}

/** Normalize whatever the user typed into the canonical code shape. */
function normalizeCode(code: string): string {
  const raw = typeof code === 'string' ? code : '';
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return cleaned.slice(0, CODE_LEN);
}

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

export function createScene(code: string, hostId: string, nowMs: number): SceneState {
  const createdAt = num(nowMs);
  const sceneCode = normalizeCode(code);
  const events: SceneEvent[] = [
    ev(0, 'scene_start', `Scene ${sceneCode || '----'} opened`, hostId || undefined, {
      code: sceneCode,
    }),
  ];
  const participants: Participant[] = [];

  if (hostId) {
    const host: Participant = {
      id: hostId,
      name: 'Responder 1',
      joinedAt: 0,
      role: 'unassigned',
      status: 'active',
      lastSeen: 0,
      isHost: true,
      trained: false,
    };
    participants.push(host);
    events.push(
      ev(0, 'join', 'Responder 1 joined as host', hostId, {
        name: host.name,
        isHost: true,
        trained: false,
      }),
    );
  }

  return {
    code: sceneCode,
    createdAt,
    participants,
    events,
    compressionRate: null,
    compressionSamples: [],
    aedStatus: 'unknown',
    online: true,
    emsEtaSec: null,
  };
}

// ---------------------------------------------------------------------------
// reduce — pure. Never mutates. Always returns a new object when anything moved.
// ---------------------------------------------------------------------------

export function reduce(s: SceneState, a: SceneAction, nowMs: number): SceneState {
  if (!s || !a || typeof (a as any).type !== 'string') return s;

  // 'replace' is the one action that ignores the current state entirely: a
  // non-host client taking the host's authoritative snapshot.
  if (a.type === 'replace') {
    return a.state && Array.isArray(a.state.participants) ? a.state : s;
  }

  const t = rel(s, nowMs);

  switch (a.type) {
    // -----------------------------------------------------------------------
    case 'join': {
      const p = a.p;
      if (!p || !p.id) return s;

      const idx = s.participants.findIndex((x) => x.id === p.id);
      const trained = !!p.trained;

      if (idx === -1) {
        const name = (p.name || '').trim() || `Responder ${s.participants.length + 1}`;
        const joined: Participant = {
          id: p.id,
          name,
          joinedAt: t,
          role: 'unassigned',
          status: 'active',
          lastSeen: t,
          isHost: !!p.isHost,
          trained,
        };
        return {
          ...s,
          participants: s.participants.concat([joined]),
          events: withEvents(s.events, [
            ev(
              t,
              'join',
              `${name} joined${joined.isHost ? ' as host' : ''}${trained ? ' (says CPR trained)' : ''}`,
              p.id,
              { name, isHost: joined.isHost, trained },
            ),
          ]),
        };
      }

      // Already known: a rejoin after a drop, or a rename mid-scene.
      const prev = s.participants[idx];
      const name = (p.name || '').trim() || prev.name;
      const rejoining = prev.status === 'left';
      const next: Participant = {
        ...prev,
        name,
        trained,
        isHost: prev.isHost || !!p.isHost,
        status: 'active',
        lastSeen: t,
      };
      const participants = replaceAt(s.participants, idx, next);

      if (rejoining) {
        return {
          ...s,
          participants,
          events: withEvents(s.events, [
            ev(t, 'join', `${name} rejoined`, p.id, { name, trained, rejoined: true }),
          ]),
        };
      }
      if (prev.name !== name) {
        return {
          ...s,
          participants,
          events: withEvents(s.events, [
            ev(t, 'note', `${prev.name} is now ${name}`, p.id, { from: prev.name, to: name }),
          ]),
        };
      }
      // Nothing worth a line in the handoff record.
      return { ...s, participants };
    }

    // -----------------------------------------------------------------------
    case 'leave': {
      const idx = s.participants.findIndex((x) => x.id === a.id);
      if (idx === -1) return s;

      const prev = s.participants[idx];
      if (prev.status === 'left') return s;

      const droppedRole = prev.role;
      // They stay in the array — the handoff record has to show the gap.
      const next: Participant = {
        ...prev,
        status: 'left',
        role: 'unassigned',
        lastSeen: t,
      };

      const added: SceneEvent[] = [
        ev(
          t,
          'leave',
          droppedRole === 'unassigned'
            ? `${prev.name} left`
            : `${prev.name} left — dropped ${roleLabel(droppedRole)}`,
          prev.id,
          { name: prev.name, droppedRole },
        ),
      ];

      // If the person who left was the one compressing, compressions did stop.
      // Only log it when the record currently says they were running.
      if (droppedRole === 'compressions' && compressionsUnderway(s.events)) {
        added.push(
          ev(t, 'compressions_stop', `Compressions interrupted — ${prev.name} left`, prev.id, {
            reason: 'left',
          }),
        );
      }

      return {
        ...s,
        participants: replaceAt(s.participants, idx, next),
        events: withEvents(s.events, added),
      };
    }

    // -----------------------------------------------------------------------
    case 'heartbeat': {
      // lastSeen only. This fires every couple of seconds per phone — logging
      // it would bury the record.
      const idx = s.participants.findIndex((x) => x.id === a.id);
      if (idx === -1) return s;
      const prev = s.participants[idx];
      if (prev.lastSeen === t) return s;
      return {
        ...s,
        participants: replaceAt(s.participants, idx, { ...prev, lastSeen: t }),
      };
    }

    // -----------------------------------------------------------------------
    case 'struggle': {
      // A rescuer says they are failing the physical job (or has recovered).
      // This is the only input that can set 'struggling', and the commander's
      // fatigue rule keys off it, so it is logged: an EMS handoff that hides
      // the moment compressions started degrading is worthless.
      const idx = s.participants.findIndex((x) => x.id === a.id);
      if (idx === -1) return s;
      const prev = s.participants[idx];
      if (prev.status === 'left') return s;

      const next: ParticipantStatus = a.struggling ? 'struggling' : 'active';
      if (prev.status === next) return s;

      const detail = a.struggling
        ? `${prev.name} called for relief from ${roleLabel(prev.role)}`
        : `${prev.name} is back to full effort`;

      return {
        ...s,
        participants: replaceAt(s.participants, idx, { ...prev, status: next, lastSeen: t }),
        events: withEvents(s.events, [
          ev(t, 'note', detail, a.id, { struggling: a.struggling, role: prev.role }),
        ]),
      };
    }

    // -----------------------------------------------------------------------
    case 'apply_plan': {
      const plan = a.plan;
      if (!plan || !Array.isArray(plan.assignments) || plan.assignments.length === 0) return s;

      const byId = new Map<string, RoleId>();
      for (const asg of plan.assignments) {
        if (asg && asg.participantId && asg.role) byId.set(asg.participantId, asg.role);
      }
      if (byId.size === 0) return s;

      let anyChange = false;
      let isReassign = false;
      const roles: Record<string, RoleId> = {};
      const lines: string[] = [];

      const participants = s.participants.map((p) => {
        const role = byId.get(p.id);
        // Never hand a job to someone who has walked away.
        if (!role || p.status === 'left' || role === p.role) {
          if (p.status !== 'left') roles[p.id] = p.role;
          return p;
        }
        anyChange = true;
        // Moving off a real job (not off the bench) is a reassignment.
        if (p.role !== 'unassigned') isReassign = true;
        roles[p.id] = role;
        lines.push(`${p.name} to ${roleLabel(role)}`);
        return { ...p, role };
      });

      const reasoning = typeof plan.reasoning === 'string' ? plan.reasoning : '';
      const model = typeof plan.model === 'string' ? plan.model : 'unknown';
      const degraded = !!plan.degraded;

      // Suppress an identical re-affirmation of a plan already on the record,
      // but always log a fresh line of reasoning.
      if (!anyChange) {
        let lastReasoning: string | null = null;
        for (let i = s.events.length - 1; i >= 0; i--) {
          const e = s.events[i];
          if (e.kind === 'assign' || e.kind === 'reassign') {
            lastReasoning = e.data && typeof e.data.reasoning === 'string' ? e.data.reasoning : '';
            break;
          }
        }
        if (lastReasoning !== null && lastReasoning === reasoning) return s;
      }

      const kind: SceneEvent['kind'] = isReassign ? 'reassign' : 'assign';
      // The reader of this line is a medic scanning the record in ten seconds,
      // and the renderer already names the kind. Say only what moved.
      const detail = lines.length
        ? lines.join(', ')
        : 'plan re-evaluated, no roles moved';

      return {
        ...s,
        participants,
        events: withEvents(s.events, [
          ev(t, kind, detail, undefined, {
            model,
            degraded,
            reasoning,
            roles,
            latencyMs: num(plan.latencyMs, 0),
            announcement: plan.roomAnnouncement || null,
          }),
        ]),
      };
    }

    // -----------------------------------------------------------------------
    case 'rate': {
      const raw = a.bpm;
      const bpm = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;

      if (bpm === null) {
        if (s.compressionRate === null) return s;
        // Tracking dropped out. Record the value going away, not a phantom
        // band crossing — the band memory lives in the log, not in this field.
        return { ...s, compressionRate: null };
      }

      const rounded = Math.round(bpm * 10) / 10;
      const samples = s.compressionSamples.concat([{ t, bpm: rounded }]);
      const capped =
        samples.length > MAX_SAMPLES ? samples.slice(samples.length - MAX_SAMPLES) : samples;

      const band = bandOf(rounded);
      const prevBand = lastLoggedBand(s.events);

      const next: SceneState = {
        ...s,
        compressionRate: rounded,
        compressionSamples: capped,
      };

      if (band === prevBand) return next;

      return {
        ...next,
        events: withEvents(s.events, [
          ev(t, 'rate_sample', `Rate ${Math.round(rounded)}/min — ${BAND_TEXT[band]}`, undefined, {
            bpm: rounded,
            band,
            prevBand,
          }),
        ]),
      };
    }

    // -----------------------------------------------------------------------
    case 'aed': {
      const status = a.status;
      const valid: AedStatus[] = ['unknown', 'enroute', 'onscene', 'attached', 'shock_delivered'];
      if (valid.indexOf(status) === -1) return s;
      if (s.aedStatus === status) return s;

      const added: SceneEvent[] = [];
      if (status === 'enroute') {
        added.push(ev(t, 'aed_enroute', 'AED retrieval underway', undefined, { status }));
      } else if (status === 'onscene') {
        added.push(ev(t, 'note', 'AED on scene', undefined, { status }));
      } else if (status === 'attached') {
        added.push(ev(t, 'aed_attached', 'AED pads attached', undefined, { status }));
      } else if (status === 'shock_delivered') {
        added.push(ev(t, 'shock', 'Shock delivered', undefined, { status }));
      }

      return { ...s, aedStatus: status, events: withEvents(s.events, added) };
    }

    // -----------------------------------------------------------------------
    case 'event': {
      const incoming = a.ev;
      if (!incoming || !incoming.kind) return s;
      const e: SceneEvent = { ...incoming, t };
      return { ...s, events: withEvents(s.events, [e]) };
    }

    // -----------------------------------------------------------------------
    case 'online': {
      const online = !!a.online;
      if (s.online === online) return s;
      return {
        ...s,
        online,
        events: withEvents(s.events, [
          online
            ? ev(t, 'online', 'Back online — devices resynced')
            : ev(t, 'offline', 'Offline — running on this device alone'),
        ]),
      };
    }

    // -----------------------------------------------------------------------
    default:
      return s;
  }
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** ms since the scene opened. Clamped at zero so a skewed phone never counts up from negative. */
export function elapsed(s: SceneState, nowMs: number): number {
  if (!s) return 0;
  return Math.max(0, num(nowMs) - num(s.createdAt));
}

/** "M:SS". 65000 -> "1:05". Negatives, NaN and garbage -> "0:00". */
export function fmtClock(ms: number): string {
  const v = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.floor(v / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}
