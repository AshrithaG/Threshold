'use client';

// ---------------------------------------------------------------------------
// lib/aed.ts
//
// "Where is the nearest AED and how long will it take me to get it back here?"
//
// Two-tier answer, and the second tier is always computed FIRST so it can be
// returned instantly if anything at all goes wrong:
//   1. straight-line distance to the nearest demo AED at a 1.4 m/s walk
//   2. a real Mapbox walking route via /api/aed, when a token is configured
//
// Never throws. Returns null only when there is genuinely no AED data at all.
// The underlying location list is UNVERIFIED DEMO DATA — see lib/aed-data.ts.
// ---------------------------------------------------------------------------

import {
  AED_LOCATIONS,
  CAMPUS_CENTER,
  haversineMeters,
  isCoords,
  nearestAed,
  type AedLocation,
} from '@/lib/aed-data';

export interface AedRoute {
  name: string;
  coords: [number, number];
  etaSec: number;
  distanceM: number;
  steps: string[];
}

/** Brisk-but-real indoor/outdoor walking pace. Someone fetching an AED runs, but
 *  they also open doors, wait for a lift, and come back. 1.4 m/s is honest. */
const WALK_SPEED_MPS = 1.4;

/** Everything on the client is on a 3s leash. A hung request must not freeze the UI. */
const FETCH_TIMEOUT_MS = 3000;

const MAX_STEPS = 10;

/**
 * The answer we can always give, with no network at all.
 * Straight-line distance, assumed walking speed, one plain-language step.
 */
function straightLineRoute(from: [number, number], target: AedLocation): AedRoute {
  const raw = haversineMeters(from, target.coords);
  const distanceM = Number.isFinite(raw) ? Math.round(raw) : 0;
  // Floor at 15s: nobody teleports to a cabinet, even one in the same room.
  const etaSec = Math.max(15, Math.round(distanceM / WALK_SPEED_MPS));
  return {
    name: target.name,
    coords: target.coords,
    etaSec,
    distanceM,
    steps: [`Head towards ${target.name} — ${target.description}`],
  };
}

/**
 * Nearest AED plus a walking route to it.
 *
 * @param from [longitude, latitude] of the scene. An invalid or missing fix
 *             falls back to the campus centroid rather than failing.
 * @returns    an AedRoute, or null only if the AED dataset is empty.
 */
export async function aedRoute(from: [number, number]): Promise<AedRoute | null> {
  if (!Array.isArray(AED_LOCATIONS) || AED_LOCATIONS.length === 0) return null;

  const origin: [number, number] = isCoords(from) ? [from[0], from[1]] : CAMPUS_CENTER;

  let target: AedLocation | null = null;
  try {
    target = nearestAed(origin);
  } catch {
    target = AED_LOCATIONS[0] || null;
  }
  if (!target) return null;

  // Computed up front so every failure path below is a plain `return fallback`.
  const fallback = straightLineRoute(origin, target);

  if (typeof fetch !== 'function') return fallback;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: any = null;

  try {
    if (controller) {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* aborting an already-settled request is not an error we care about */
        }
      }, FETCH_TIMEOUT_MS);
    }

    const res = await fetch('/api/aed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: origin, to: target.coords }),
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    });

    // 204 is the server saying "no routing configured, use your own estimate".
    if (!res || res.status === 204 || !res.ok) return fallback;

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      return fallback;
    }
    if (!data || typeof data !== 'object') return fallback;

    const etaSec = Number(data.etaSec);
    const distanceM = Number(data.distanceM);

    const steps: string[] = [];
    if (Array.isArray(data.steps)) {
      for (const s of data.steps) {
        if (typeof s === 'string' && s.trim()) {
          steps.push(s.trim());
          if (steps.length >= MAX_STEPS) break;
        }
      }
    }

    return {
      name: target.name,
      coords: target.coords,
      // Mix and match: keep whichever fields the upstream actually gave us.
      etaSec: Number.isFinite(etaSec) && etaSec > 0 ? Math.round(etaSec) : fallback.etaSec,
      distanceM:
        Number.isFinite(distanceM) && distanceM >= 0
          ? Math.round(distanceM)
          : fallback.distanceM,
      steps: steps.length > 0 ? steps : fallback.steps,
    };
  } catch {
    // Aborted, offline, blocked, parse failure. The runner still gets a heading.
    return fallback;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
