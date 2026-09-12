'use client';

// ---------------------------------------------------------------------------
// lib/local-transport.ts
//
// The zero-configuration transport. Same RealtimeHandle contract as the
// Supabase path, implemented over an SSE stream down and plain POSTs up.
//
// Preferred order in lib/realtime.ts is: Supabase, then this, then nothing.
// Supabase survives more than one server process and is the honest answer for
// "how would this actually ship". This one needs no account, no key and no
// outbound websocket, which is the honest answer for "will the demo work on
// conference wifi".
//
// Downstream is a poll, not a stream, and that is deliberate. Server-sent
// events work perfectly on localhost and deliver NOTHING through a Cloudflare
// quick tunnel, which is what judges' phones will be talking to: the tunnel
// buffers the response and hands back a 200 with no frames and no error. That
// failure is invisible until the room does not sync. A short GET on a loop has
// no such failure mode -- it works through proxies, tunnels and campus wifi --
// and at this interval the room still feels immediate.
//
// Like the Supabase path, this module is not allowed to throw at a caller. A
// dead stream degrades to single-device and says so through getStatus().
// ---------------------------------------------------------------------------

import type { SceneState } from '@/lib/types';
import type { SceneAction } from '@/lib/scene';
import type { RealtimeHandle, RealtimeStatus } from '@/lib/realtime';

/** Host snapshots are coalesced; matches STATE_THROTTLE_MS in realtime.ts. */
const STATE_THROTTLE_MS = 250;

/**
 * Downstream poll interval. Roles change every few seconds, so this is well
 * inside human reaction time, and it keeps a four-phone scene at a handful of
 * tiny requests per second.
 */
const POLL_MS = 900;

/** Consecutive failed polls before the badge stops claiming to be live. */
const POLL_FAIL_LIMIT = 3;

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a subscriber blowing up must not take down the transport */
  }
}

function post(code: string, from: string, kind: 'action' | 'state', payload: unknown): void {
  try {
    const body = JSON.stringify({ code, from, kind, payload });

    // sendBeacon survives the page being backgrounded mid-scene, which is
    // exactly when a 'leave' matters most. It is best-effort by design.
    if (kind === 'action' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon('/api/scene/send', blob)) return;
    }

    void fetch('/api/scene/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      cache: 'no-store',
    }).catch(() => undefined);
  } catch {
    /* offline — the caller already applied this locally */
  }
}

export function joinLocalChannel(
  code: string,
  selfId: string,
  _meta: { name: string; trained: boolean; isHost: boolean },
): RealtimeHandle {
  const actionCbs: Array<(a: SceneAction) => void> = [];
  const stateCbs: Array<(s: SceneState) => void> = [];
  const presenceCbs: Array<(ids: string[]) => void> = [];

  let status: RealtimeStatus = 'connecting';
  let dead = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let since = 0;
  let fails = 0;

  let pendingState: SceneState | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;

  const applyFrame = (frame: any) => {
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'action' && frame.action) {
      for (const cb of actionCbs) safe(() => cb(frame.action as SceneAction));
    } else if (frame.kind === 'state' && frame.state) {
      for (const cb of stateCbs) safe(() => cb(frame.state as SceneState));
    } else if (frame.kind === 'presence' && Array.isArray(frame.ids)) {
      for (const cb of presenceCbs) safe(() => cb(frame.ids as string[]));
    }
  };

  const schedule = () => {
    if (dead) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, POLL_MS);
  };

  const tick = async () => {
    if (dead || inFlight) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      const url =
        `/api/scene/poll?code=${encodeURIComponent(code)}` +
        `&id=${encodeURIComponent(selfId)}&since=${since}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`poll ${res.status}`);
      const data = await res.json();

      // Advance the cursor before dispatching: a subscriber that throws must
      // not make this client replay the same frames forever.
      if (typeof data?.seq === 'number' && data.seq >= since) since = data.seq;

      fails = 0;
      status = 'live';

      if (Array.isArray(data?.frames)) {
        for (const frame of data.frames) applyFrame(frame);
      }
      if (Array.isArray(data?.presence)) {
        for (const cb of presenceCbs) safe(() => cb(data.presence as string[]));
      }
    } catch {
      fails += 1;
      if (fails >= POLL_FAIL_LIMIT) status = 'offline';
      else if (status === 'live') status = 'connecting';
    } finally {
      inFlight = false;
      schedule();
    }
  };

  if (typeof window !== 'undefined' && selfId) {
    void tick();
  } else {
    status = 'offline';
  }

  const flushState = () => {
    stateTimer = null;
    if (!pendingState) return;
    const s = pendingState;
    pendingState = null;
    post(code, selfId, 'state', s);
  };

  return {
    send(action: SceneAction) {
      if (dead) return;
      post(code, selfId, 'action', action);
    },

    broadcastState(s: SceneState) {
      if (dead || !s) return;
      pendingState = s;
      if (stateTimer) return;
      stateTimer = setTimeout(flushState, STATE_THROTTLE_MS);
    },

    onAction(cb) {
      if (typeof cb === 'function') actionCbs.push(cb);
    },

    onState(cb) {
      if (typeof cb === 'function') stateCbs.push(cb);
    },

    onPresence(cb) {
      if (typeof cb === 'function') presenceCbs.push(cb);
    },

    leave() {
      dead = true;
      status = 'offline';
      if (timer) clearTimeout(timer);
      if (stateTimer) clearTimeout(stateTimer);
      timer = null;
      stateTimer = null;
    },

    getStatus() {
      return status;
    },
  };
}
