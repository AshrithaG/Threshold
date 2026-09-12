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
// Like the Supabase path, this module is not allowed to throw at a caller. A
// dead stream degrades to single-device and says so through getStatus().
// ---------------------------------------------------------------------------

import type { SceneState } from '@/lib/types';
import type { SceneAction } from '@/lib/scene';
import type { RealtimeHandle, RealtimeStatus } from '@/lib/realtime';

/** Host snapshots are coalesced; matches STATE_THROTTLE_MS in realtime.ts. */
const STATE_THROTTLE_MS = 250;

/** EventSource reconnects on its own, but only after the browser's own backoff. */
const RECONNECT_MS = 1500;

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
  let source: EventSource | null = null;
  let dead = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  let pendingState: SceneState | null = null;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (dead) return;
    try {
      const url = `/api/scene/stream?code=${encodeURIComponent(code)}&id=${encodeURIComponent(selfId)}`;
      source = new EventSource(url);
    } catch {
      status = 'offline';
      return;
    }

    source.onopen = () => {
      status = 'live';
    };

    source.onmessage = (e: MessageEvent) => {
      let frame: any;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;

      // Any frame at all proves the pipe is up, including the keepalive.
      status = 'live';

      if (frame.kind === 'action' && frame.action) {
        for (const cb of actionCbs) safe(() => cb(frame.action as SceneAction));
      } else if (frame.kind === 'state' && frame.state) {
        for (const cb of stateCbs) safe(() => cb(frame.state as SceneState));
      } else if (frame.kind === 'presence' && Array.isArray(frame.ids)) {
        for (const cb of presenceCbs) safe(() => cb(frame.ids as string[]));
      }
    };

    source.onerror = () => {
      // EventSource retries by itself unless the server closed cleanly. Report
      // the truth in the meantime rather than showing a live badge over a dead
      // pipe, and re-open by hand if the browser gave up entirely.
      status = 'connecting';
      if (source && source.readyState === 2 /* CLOSED */) {
        status = 'offline';
        try {
          source.close();
        } catch {
          /* already gone */
        }
        source = null;
        if (retry) clearTimeout(retry);
        retry = setTimeout(open, RECONNECT_MS);
      }
    };
  };

  if (typeof window !== 'undefined' && selfId) {
    open();
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
      if (retry) clearTimeout(retry);
      if (stateTimer) clearTimeout(stateTimer);
      try {
        source?.close();
      } catch {
        /* already gone */
      }
      source = null;
    },

    getStatus() {
      return status;
    },
  };
}
