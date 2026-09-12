// ---------------------------------------------------------------------------
// app/api/scene/poll/route.ts
//
// GET /api/scene/poll?code=4B2K&id=<device>&since=<seq>
//
// The delivery path that actually survives the network between a judge's phone
// and this laptop. An ordinary short GET: no stream to buffer, no upgrade to
// negotiate, nothing for a proxy or a captive portal to hold open and discard.
//
// Answers 200 with { seq, frames, presence } and, on anything malformed, an
// empty envelope rather than an error -- a client that cannot poll must degrade
// to single-device, never to a broken screen.
// ---------------------------------------------------------------------------

import { poll } from '@/lib/server-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function empty(): Response {
  return new Response(JSON.stringify({ seq: 0, frames: [], presence: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const code = (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const id = (url.searchParams.get('id') || '').slice(0, 64);
    const since = Number(url.searchParams.get('since') || '0');
    if (code.length !== 4 || !id) return empty();

    const out = poll(code, id, Number.isFinite(since) ? since : 0);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return empty();
  }
}
