'use client';

// ---------------------------------------------------------------------------
// Threshold — cross-device transport.
//
// One Supabase Realtime channel per scene. Actions fan out to every phone in
// the room; the host also pushes an authoritative state snapshot that late
// joiners and drifted clients adopt wholesale.
//
// This module is allowed to fail. If Supabase is not configured, or the
// websocket never comes up, joinChannel() still returns a live-looking handle
// that quietly does nothing and reports 'offline'. The app then runs
// single-device with a banner. Nothing in here may ever throw at a caller.
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { SceneState } from '@/lib/types';
import type { SceneAction } from '@/lib/scene';
import { joinLocalChannel } from '@/lib/local-transport';

export interface RealtimeHandle {
  send(action: SceneAction): void;
  broadcastState(s: SceneState): void;
  onAction(cb: (a: SceneAction) => void): void;
  onState(cb: (s: SceneState) => void): void;
  onPresence(cb: (ids: string[]) => void): void;
  leave(): void;
  getStatus(): 'connecting' | 'live' | 'offline';
}

export type RealtimeStatus = 'connecting' | 'live' | 'offline';

/** Host state snapshots are coalesced to at most one per this many ms. */
const STATE_THROTTLE_MS = 250;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// These two must be written as literal `process.env.NEXT_PUBLIC_*` member
// expressions — that is the only form Next inlines into the client bundle.
function url(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return typeof v === 'string' ? v.trim() : '';
}

function key(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return typeof v === 'string' ? v.trim() : '';
}

export function realtimeAvailable(): boolean {
  const u = url();
  const k = key();
  return u.length > 0 && k.length > 0 && /^https?:\/\//i.test(u);
}

// ---------------------------------------------------------------------------
// Client singleton — one websocket for the whole tab, however many times a
// component remounts.
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (client) return client;
  if (!realtimeAvailable()) return null;
  try {
    client = createClient(url(), key(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  } catch {
    client = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a subscriber blowing up must not take down the transport */
  }
}

/** Fire and forget: Supabase send/track return promises that can reject. */
function ignore(p: unknown): void {
  if (p && typeof (p as Promise<unknown>).then === 'function') {
    (p as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
  }
}

function topicFor(code: string): string {
  const c = (typeof code === 'string' ? code : '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return `scene:${c}`;
}

function noopHandle(): RealtimeHandle {
  return {
    send() {},
    broadcastState() {},
    onAction() {},
    onState() {},
    onPresence() {},
    leave() {},
    getStatus() {
      return 'offline';
    },
  };
}

// ---------------------------------------------------------------------------
// joinChannel
// ---------------------------------------------------------------------------

export function joinChannel(
  code: string,
  selfId: string,
  meta: { name: string; trained: boolean; isHost: boolean },
): RealtimeHandle {
  // Server render or a bad id: nothing can talk to anything.
  if (typeof window === 'undefined' || !selfId) return noopHandle();

  // No Supabase project configured. Fall back to this app's own SSE bus rather
  // than to silence — the room still coordinates, it just does so through the
  // one server everybody already loaded the page from. See lib/local-transport.
  const sb = getClient();
  if (!sb) return joinLocalChannel(code, selfId, meta);

  const actionCbs: Array<(a: SceneAction) => void> = [];
  const stateCbs: Array<(s: SceneState) => void> = [];
  const presenceCbs: Array<(ids: string[]) => void> = [];

  let status: RealtimeStatus = 'connecting';
  let disposed = false;

  // Replayed to callbacks that register after the first payload lands.
  let lastState: SceneState | null = null;
  let lastPresence: string[] = [];

  // broadcastState throttle
  let pending: SceneState | null = null;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let channel: RealtimeChannel;
  try {
    channel = sb.channel(topicFor(code), {
      config: {
        broadcast: { self: false },
        presence: { key: selfId },
      },
    });
  } catch {
    return noopHandle();
  }

  // -- inbound ---------------------------------------------------------------

  function emitPresence(): void {
    if (disposed) return;
    let ids: string[] = [];
    try {
      const state = channel.presenceState() as Record<string, Array<Record<string, any>>>;
      const seen = new Set<string>();
      for (const k of Object.keys(state || {})) {
        if (k) seen.add(k);
        const metas = state[k];
        if (Array.isArray(metas)) {
          for (const m of metas) {
            if (m && typeof m.id === 'string' && m.id) seen.add(m.id);
          }
        }
      }
      ids = Array.from(seen);
    } catch {
      ids = [];
    }
    lastPresence = ids;
    for (const cb of presenceCbs) safe(() => cb(ids.slice()));
  }

  try {
    channel
      .on('broadcast', { event: 'action' }, (msg: any) => {
        if (disposed) return;
        const a = msg && msg.payload ? (msg.payload.action ?? msg.payload) : null;
        if (!a || typeof a.type !== 'string') return;
        for (const cb of actionCbs) safe(() => cb(a as SceneAction));
      })
      .on('broadcast', { event: 'state' }, (msg: any) => {
        if (disposed) return;
        const raw = msg && msg.payload ? (msg.payload.state ?? msg.payload) : null;
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.participants)) return;
        lastState = raw as SceneState;
        for (const cb of stateCbs) safe(() => cb(raw as SceneState));
      })
      .on('presence', { event: 'sync' }, () => emitPresence())
      .on('presence', { event: 'join' }, () => emitPresence())
      .on('presence', { event: 'leave' }, () => emitPresence());
  } catch {
    return noopHandle();
  }

  // -- subscribe -------------------------------------------------------------

  try {
    channel.subscribe((s: string) => {
      if (disposed) return;
      if (s === 'SUBSCRIBED') {
        status = 'live';
        ignore(
          channel.track({
            id: selfId,
            name: meta && meta.name ? meta.name : '',
            trained: !!(meta && meta.trained),
            isHost: !!(meta && meta.isHost),
            at: Date.now(),
          }),
        );
        emitPresence();
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
        status = 'offline';
      }
    });
  } catch {
    status = 'offline';
  }

  // -- outbound --------------------------------------------------------------

  function rawSend(event: 'action' | 'state', payload: Record<string, unknown>): void {
    if (disposed) return;
    try {
      ignore(channel.send({ type: 'broadcast', event, payload }));
    } catch {
      /* a dead socket must not surface to the UI */
    }
  }

  function flush(): void {
    timer = null;
    if (disposed || !pending) return;
    const s = pending;
    pending = null;
    lastSentAt = Date.now();
    rawSend('state', { state: s });
  }

  // -- handle ----------------------------------------------------------------

  return {
    send(action: SceneAction) {
      if (disposed || !action || typeof action.type !== 'string') return;
      rawSend('action', { action });
    },

    broadcastState(s: SceneState) {
      if (disposed || !s) return;
      // Always keep the newest; never more than one send per throttle window.
      pending = s;
      const wait = STATE_THROTTLE_MS - (Date.now() - lastSentAt);
      if (wait <= 0 && timer === null) {
        flush();
        return;
      }
      if (timer === null) timer = setTimeout(flush, wait > 0 ? wait : 0);
    },

    onAction(cb: (a: SceneAction) => void) {
      if (typeof cb === 'function') actionCbs.push(cb);
    },

    onState(cb: (s: SceneState) => void) {
      if (typeof cb !== 'function') return;
      stateCbs.push(cb);
      if (lastState) {
        const snapshot = lastState;
        safe(() => cb(snapshot));
      }
    },

    onPresence(cb: (ids: string[]) => void) {
      if (typeof cb !== 'function') return;
      presenceCbs.push(cb);
      if (lastPresence.length) {
        const ids = lastPresence.slice();
        safe(() => cb(ids));
      }
    },

    leave() {
      if (disposed) return;
      disposed = true;
      status = 'offline';
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      actionCbs.length = 0;
      stateCbs.length = 0;
      presenceCbs.length = 0;
      try {
        ignore(channel.untrack());
      } catch {
        /* already gone */
      }
      try {
        ignore(channel.unsubscribe());
      } catch {
        /* already gone */
      }
      try {
        ignore(sb.removeChannel(channel));
      } catch {
        /* already gone */
      }
    },

    getStatus() {
      return status;
    },
  };
}
