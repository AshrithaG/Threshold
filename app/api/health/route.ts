import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// Read env at request time, never bake a build-time snapshot into a static page.
export const dynamic = 'force-dynamic';

/**
 * Integration readiness, reported honestly and cheaply.
 *
 * `ok` means only "the environment variables this integration needs are
 * non-empty". No outbound calls are made: this endpoint is polled on page load
 * and must answer instantly. No key material is ever included in the response.
 */

function has(v: string | undefined | null): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Model names are not secrets, but bound the echoed length anyway. */
function name(v: string | undefined | null): string | null {
  return has(v) ? String(v).trim().slice(0, 64) : null;
}

export interface HealthReport {
  k2: { ok: boolean; model: string | null };
  voice: { ok: boolean; mode: 'grok-tts' | 'browser' };
  realtime: { ok: boolean; mode: 'supabase' | 'local-bus' };
  mapbox: { ok: boolean };
  localModel: { ok: boolean };
}

export async function GET() {
  const env = process.env;

  // IFM K2 Horizon — commander reasoning. Base URL and model have defaults in
  // the commander module, so the key alone decides whether it is configured.
  const k2Ok = has(env.IFM_API_KEY);

  // xAI Grok — spoken assignments. Without it, voice falls back to the
  // browser's speechSynthesis, which is why `mode` flips rather than failing.
  const voiceOk = has(env.XAI_API_KEY);

  // Cross-device multiplayer. Supabase Realtime when it is configured; this
  // app's own in-process SSE bus otherwise. The second tier needs no account
  // and no key, so multi-device is never actually off — only less durable.
  const supabase =
    has(env.NEXT_PUBLIC_SUPABASE_URL) && has(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

  // Mapbox — AED routing and ETA. Without it: static AED list.
  const mapboxOk = has(env.NEXT_PUBLIC_MAPBOX_TOKEN);

  // Optional local OpenAI-compatible model for offline reasoning.
  const localOk = has(env.LOCAL_MODEL_URL);

  const body: HealthReport = {
    k2: { ok: k2Ok, model: name(env.IFM_MODEL) },
    voice: { ok: voiceOk, mode: voiceOk ? 'grok-tts' : 'browser' },
    realtime: { ok: true, mode: supabase ? 'supabase' : 'local-bus' },
    mapbox: { ok: mapboxOk },
    localModel: { ok: localOk },
  };

  return NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
