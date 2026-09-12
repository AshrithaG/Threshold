// ---------------------------------------------------------------------------
// lib/server-bus.ts
//
// In-process fan-out for scene traffic. One Map, one process, no external
// service, no API key.
//
// This exists because the multiplayer mechanic is the product, and a demo that
// only works if a Supabase project happens to be reachable from conference wifi
// is not a demo. Every phone on the same dev server shares this bus, so the
// room coordinates with nothing configured at all. Supabase Realtime is still
// preferred when it is available — it survives more than one server process —
// but it is now an upgrade rather than a requirement.
//
// Scope and lifetime are deliberately small: scenes are ephemeral, the whole
// thing is memory-only, and nothing here is durable across a restart. That
// matches the product (a scene lasts minutes) and keeps the security story
// clean: there is no database of emergencies to leak.
// ---------------------------------------------------------------------------

export type BusFrame =
  | { kind: 'action'; from: string; action: unknown }
  | { kind: 'state'; from: string; state: unknown }
  | { kind: 'presence'; ids: string[] }
  | { kind: 'ping' };

interface Subscriber {
  id: string;
  send: (frame: BusFrame) => void;
}

/** A scene with no subscribers is dropped after this long. */
const SCENE_TTL_MS = 45 * 60 * 1000;

interface Room {
  subs: Set<Subscriber>;
  lastTouched: number;
}

// Next keeps route modules alive across requests, but a dev-mode hot reload can
// re-evaluate this file. Hanging the map off globalThis means a reload during a
// rehearsal does not silently split the room into two.
const GLOBAL_KEY = '__threshold_bus__';

function rooms(): Map<string, Room> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<string, Room>();
  return g[GLOBAL_KEY] as Map<string, Room>;
}

function normalize(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

/** Drop rooms nobody has touched in a while so a long-running server does not grow. */
function sweep(): void {
  const now = Date.now();
  const all = rooms();
  for (const [code, room] of all) {
    if (room.subs.size === 0 && now - room.lastTouched > SCENE_TTL_MS) {
      all.delete(code);
    }
  }
}

function roomFor(code: string): Room | null {
  const c = normalize(code);
  if (c.length !== 4) return null;
  const all = rooms();
  let room = all.get(c);
  if (!room) {
    room = { subs: new Set<Subscriber>(), lastTouched: Date.now() };
    all.set(c, room);
  }
  room.lastTouched = Date.now();
  return room;
}

function presenceIds(room: Room): string[] {
  const seen = new Set<string>();
  for (const s of room.subs) seen.add(s.id);
  return Array.from(seen);
}

function announcePresence(room: Room): void {
  const ids = presenceIds(room);
  for (const s of room.subs) {
    try {
      s.send({ kind: 'presence', ids });
    } catch {
      /* a dead socket must not stop the others hearing about it */
    }
  }
}

/**
 * Attach a listener to a scene. Returns an unsubscribe function; calling it
 * twice is harmless.
 */
export function subscribe(
  code: string,
  id: string,
  send: (frame: BusFrame) => void,
): () => void {
  const room = roomFor(code);
  if (!room) return () => undefined;

  const sub: Subscriber = { id: String(id || 'anon').slice(0, 64), send };
  room.subs.add(sub);
  announcePresence(room);
  sweep();

  let done = false;
  return () => {
    if (done) return;
    done = true;
    room.subs.delete(sub);
    room.lastTouched = Date.now();
    announcePresence(room);
  };
}

/**
 * Fan a frame out to everyone in the scene except its author. Senders already
 * applied their own action locally; echoing it back would double-apply joins.
 */
export function publish(code: string, frame: BusFrame): void {
  const room = roomFor(code);
  if (!room) return;
  const from = 'from' in frame ? frame.from : null;
  for (const s of room.subs) {
    if (from && s.id === from) continue;
    try {
      s.send(frame);
    } catch {
      /* the stream will be reaped by its own cancel handler */
    }
  }
}

/** Diagnostics for the health panel. Never includes scene contents. */
export function busStats(): { scenes: number; subscribers: number } {
  let subscribers = 0;
  for (const room of rooms().values()) subscribers += room.subs.size;
  return { scenes: rooms().size, subscribers };
}
