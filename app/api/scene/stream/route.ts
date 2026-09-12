// ---------------------------------------------------------------------------
// app/api/scene/stream/route.ts
//
// GET /api/scene/stream?code=4B2K&id=<device>
//
// Server-sent events: every frame published to this scene, pushed to this
// phone. One long-lived response per device, no polling, no websocket upgrade
// to negotiate through a tunnel.
// ---------------------------------------------------------------------------

import { subscribe, type BusFrame } from '@/lib/server-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Proxies and phone radios drop an idle stream. Keep it warm. */
const HEARTBEAT_MS = 15000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const id = (url.searchParams.get('id') || '').slice(0, 64);

  if (code.length !== 4 || !id) {
    return new Response('bad scene', { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (frame: BusFrame) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Flush a comment immediately: some proxies hold the response open with
      // no headers until the first byte arrives.
      write({ kind: 'ping' });

      unsubscribe = subscribe(code, id, write);
      beat = setInterval(() => write({ kind: 'ping' }), HEARTBEAT_MS);

      const stop = () => {
        if (closed) return;
        closed = true;
        if (beat) clearInterval(beat);
        if (unsubscribe) unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal?.addEventListener('abort', stop);
    },

    cancel() {
      if (beat) clearInterval(beat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and several tunnel providers buffer by default, which turns a
      // live stream into a batch delivered at the end. This disables that.
      'x-accel-buffering': 'no',
    },
  });
}
