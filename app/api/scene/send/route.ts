// ---------------------------------------------------------------------------
// app/api/scene/send/route.ts
//
// POST { code, from, kind: 'action' | 'state', payload }
//
// Fans one frame out to every other phone in the scene. Answers 204 on success
// and on anything malformed: a caller that cannot post a heartbeat must not see
// an error path, it must simply degrade to single-device.
// ---------------------------------------------------------------------------

import { publish } from '@/lib/server-bus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A scene state with hundreds of events is still small; this is an abuse cap. */
const MAX_BODY_BYTES = 512 * 1024;

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request): Promise<Response> {
  let body: any;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return noContent();
    body = JSON.parse(raw);
  } catch {
    return noContent();
  }

  if (!body || typeof body !== 'object') return noContent();

  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const from = String(body.from || '').slice(0, 64);
  if (code.length !== 4 || !from) return noContent();

  if (body.kind === 'action' && body.payload) {
    publish(code, { kind: 'action', from, action: body.payload });
  } else if (body.kind === 'state' && body.payload) {
    publish(code, { kind: 'state', from, state: body.payload });
  }

  return noContent();
}
