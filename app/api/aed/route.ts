// ---------------------------------------------------------------------------
// app/api/aed/route.ts
//
// Walking-route lookup for the AED runner. POST { from: [lng,lat], to: [lng,lat] }.
//
// Degradation contract: this endpoint NEVER 500s and never blocks the demo.
// No Mapbox token, a bad token, a slow network, a malformed upstream payload —
// all of them return 204 No Content, and lib/aed.ts silently substitutes its
// straight-line estimate. The AED runner always gets a destination.
// ---------------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM_TIMEOUT_MS = 3000;
const MAX_STEPS = 10;

/** 204 No Content: "I have nothing better than what you already computed." */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

function isCoords(v: any): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 90
  );
}

/** Mapbox wants 6dp; more just makes the URL longer. */
function fmtCoord(c: [number, number]): string {
  return `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
}

export async function POST(req: Request): Promise<Response> {
  try {
    // The Mapbox token is deliberately a NEXT_PUBLIC_* value (Mapbox tokens are
    // URL-scoped and public by design), but we still make the call server-side
    // so the client has one uniform, timeout-bounded surface to talk to.
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token || !token.trim()) return noContent();

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      return noContent();
    }
    if (!body || typeof body !== 'object') return noContent();

    const from = body.from;
    const to = body.to;
    if (!isCoords(from) || !isCoords(to)) return noContent();

    const url =
      'https://api.mapbox.com/directions/v5/mapbox/walking/' +
      `${fmtCoord(from)};${fmtCoord(to)}` +
      '?steps=true&overview=false&access_token=' +
      encodeURIComponent(token.trim());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
    } catch {
      return noContent();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return noContent();

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      return noContent();
    }

    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) return noContent();

    const durationSec = Number(route.duration);
    const distanceMeters = Number(route.distance);
    if (!Number.isFinite(durationSec) || !Number.isFinite(distanceMeters)) {
      return noContent();
    }

    const steps: string[] = [];
    const legs = Array.isArray(route.legs) ? route.legs : [];
    for (const leg of legs) {
      const legSteps = Array.isArray(leg?.steps) ? leg.steps : [];
      for (const s of legSteps) {
        const instruction = s?.maneuver?.instruction;
        if (typeof instruction === 'string' && instruction.trim()) {
          steps.push(instruction.trim());
          if (steps.length >= MAX_STEPS) break;
        }
      }
      if (steps.length >= MAX_STEPS) break;
    }

    return Response.json(
      {
        etaSec: Math.max(0, Math.round(durationSec)),
        distanceM: Math.max(0, Math.round(distanceMeters)),
        steps,
      },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // Absolutely nothing escapes this route as a 500.
    return noContent();
  }
}

/** A stray GET should not look like a crash during a live demo. */
export async function GET(): Promise<Response> {
  return noContent();
}
