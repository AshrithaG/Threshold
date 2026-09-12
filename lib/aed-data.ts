// ---------------------------------------------------------------------------
// lib/aed-data.ts
//
// ===========================================================================
// !!! DEMO DATA — NOT A VERIFIED AED REGISTRY !!!
//
// The entries below are HAND-WRITTEN PLACEHOLDERS for a hackathon demo running
// on the Carnegie Mellon Pittsburgh campus. They were not sourced from CMU
// Environmental Health & Safety, from PA DOH, from the county AED registry, or
// from any authoritative dataset. Names, room descriptions and coordinates are
// approximate and some are invented.
//
// This matters. Stale and unverified AED registries are a real, documented
// hazard: a responder sent to a cabinet that was moved, emptied, locked, or
// never existed loses the only minutes that matter. Nothing in this file may be
// presented to a user as authoritative. Any UI that surfaces these entries must
// label them as unverified demo data and must keep the "call 911, the
// dispatcher knows where the AED is" path in front of the user.
//
// Before this is ever pointed at a real building, replace this array wholesale
// with a maintained registry that has an owner, an inspection date per cabinet,
// and a revocation path.
// ===========================================================================

export interface AedLocation {
  id: string;
  name: string;
  /** where in the building the cabinet is, in the words you would shout */
  description: string;
  /** [longitude, latitude] — GeoJSON order, matching Mapbox */
  coords: [number, number];
}

/** Rough centroid of the CMU Pittsburgh campus. Used when we have no fix. */
export const CAMPUS_CENTER: [number, number] = [-79.9436, 40.4432];

/** DEMO DATA. See the banner at the top of this file. Not a registry. */
export const AED_LOCATIONS: AedLocation[] = [
  {
    id: 'tepper-quad',
    name: 'Tepper Quad',
    description: 'Ground floor, on the wall by the main Forbes Avenue elevators',
    coords: [-79.9455, 40.4441],
  },
  {
    id: 'gates-hillman',
    name: 'Gates Hillman Center',
    description: 'Level 4 commons, beside the helix stair landing',
    coords: [-79.9446, 40.4435],
  },
  {
    id: 'cohon-center',
    name: 'Cohon University Center',
    description: 'First floor, outside the information desk near Kirr Commons',
    coords: [-79.9421, 40.4437],
  },
  {
    id: 'wean-hall',
    name: 'Wean Hall',
    description: 'Fifth floor corridor, opposite the bank of elevators',
    coords: [-79.9459, 40.4427],
  },
  {
    id: 'newell-simon',
    name: 'Newell-Simon Hall',
    description: 'Third floor atrium, cabinet next to the fire extinguisher',
    coords: [-79.9452, 40.4432],
  },
  {
    id: 'doherty-hall',
    name: 'Doherty Hall',
    description: 'Second floor, at the junction by the main stairwell',
    coords: [-79.9440, 40.4425],
  },
  {
    id: 'hunt-library',
    name: 'Hunt Library',
    description: 'Entry level, left of the security gates',
    coords: [-79.9435, 40.4415],
  },
  {
    id: 'purnell-center',
    name: 'Purnell Center for the Arts',
    description: 'Lobby level, by the box office windows',
    coords: [-79.9430, 40.4443],
  },
];

/** True when a value is a usable [lng, lat] pair. */
export function isCoords(v: any): v is [number, number] {
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

/**
 * Great-circle distance in metres between two [lng, lat] pairs.
 * Pure, no I/O, safe on the server.
 */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  if (!isCoords(a) || !isCoords(b)) return Number.POSITIVE_INFINITY;
  const R = 6371008.8; // mean Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Nearest demo AED to a position, by straight-line distance.
 * Returns null only when the demo array is empty.
 */
export function nearestAed(from: [number, number]): AedLocation | null {
  if (AED_LOCATIONS.length === 0) return null;
  const origin = isCoords(from) ? from : CAMPUS_CENTER;
  let best = AED_LOCATIONS[0];
  let bestD = haversineMeters(origin, best.coords);
  for (let i = 1; i < AED_LOCATIONS.length; i++) {
    const d = haversineMeters(origin, AED_LOCATIONS[i].coords);
    if (d < bestD) {
      bestD = d;
      best = AED_LOCATIONS[i];
    }
  }
  return best;
}

/**
 * All demo AEDs ordered nearest-first, each with a straight-line distance.
 * This is the static list the UI falls back to when there is no Mapbox token.
 */
export function aedsByDistance(
  from: [number, number],
): { location: AedLocation; distanceM: number }[] {
  const origin = isCoords(from) ? from : CAMPUS_CENTER;
  return AED_LOCATIONS.map((location) => ({
    location,
    distanceM: Math.round(haversineMeters(origin, location.coords)),
  })).sort((x, y) => x.distanceM - y.distanceM);
}
