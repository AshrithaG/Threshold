// ---------------------------------------------------------------------------
// lib/roles.ts — the deterministic incident commander.
//
// Pure. No network, no I/O, no browser APIs. Safe on the server and the client.
// This is BOTH the offline brain (no key, no signal, no LLM) and the safety net
// the LLM path falls back to. If this file is wrong, the demo is wrong, so the
// rules here are explicit and boring on purpose.
// ---------------------------------------------------------------------------

import type {
  Assignment,
  CommanderPlan,
  Participant,
  RoleId,
  SceneState,
} from '@/lib/types';

/** What one role tells its human — on screen and out loud. */
export interface RoleScript {
  /** shown on that person's phone */
  instruction: string;
  /** spoken aloud on that phone: imperative, <= 18 words, no preamble */
  spoken: string;
  urgency: 'now' | 'soon';
}

/**
 * Every spoken line is heard by one frightened stranger standing over a body.
 * Verb first, body-part specific, no reassurance, no filler, <= 18 words.
 */
export const ROLE_SCRIPT: Record<RoleId, RoleScript> = {
  compressions: {
    instruction:
      'Kneel at their side. Heel of one hand on the centre of the chest, other hand on top, arms locked. Push down hard and let the chest come all the way back up. Stay on the beat.',
    spoken:
      "Heel of your hand on the centre of the chest. Push hard and fast. I'll count you.",
    urgency: 'now',
  },
  swap_ready: {
    instruction:
      'Kneel on the opposite side of the chest now, hands ready above theirs. When I call the swap, take over in under five seconds. Do not wait to be asked twice.',
    spoken:
      'Kneel opposite the compressor. Hands ready. Take over the second I call the swap.',
    urgency: 'soon',
  },
  aed: {
    instruction:
      'Find the AED — check the lobby, the front desk, the nearest wall cabinet. Bring the whole case back here, open it, and follow the pictures on the pads.',
    spoken:
      'Run for the AED. Check the lobby and the front desk. Bring the whole case back.',
    urgency: 'now',
  },
  call911: {
    instruction:
      'Call 911 on speaker and stay on the line. Street address first, then floor and nearest entrance. Say a person is down and not breathing normally. Repeat what the dispatcher says out loud.',
    spoken:
      'Call 911 now. Put it on speaker. Give the street address first, then stay on.',
    urgency: 'now',
  },
  door: {
    instruction:
      'Go to the street entrance and watch for the ambulance. Prop the door, hold the lift, and walk the medics straight back here. Do not leave until they arrive.',
    spoken:
      'Go to the street entrance. Prop the door. Wave the medics down and walk them here.',
    urgency: 'soon',
  },
  crowd: {
    instruction:
      'Clear two metres around the patient. Move bags, chairs and people back, keep the path to the door open, and stop anyone from crowding in.',
    spoken:
      'Clear two metres around the patient. Move people and bags back. Keep the doorway open.',
    urgency: 'soon',
  },
  unassigned: {
    instruction:
      'Stay close and keep your screen on. You are the next pair of hands — I will call you the moment a job opens up.',
    spoken:
      "Stand by, close to me. Keep your screen on. I'll call you when I need hands.",
    urgency: 'soon',
  },
};

/** Safe lookup — never returns undefined, even for a garbage role string. */
export function roleScript(role: RoleId): RoleScript {
  return ROLE_SCRIPT[role] || ROLE_SCRIPT.unassigned;
}

/** Roles that exactly one person should hold at a time. */
const SINGLE_OCCUPANCY: RoleId[] = [
  'compressions',
  'call911',
  'aed',
  'swap_ready',
  'door',
];

export function isSingleOccupancy(role: RoleId): boolean {
  return SINGLE_OCCUPANCY.indexOf(role) !== -1;
}

/** The AED is already on the patient — nobody needs to go fetch it. */
export function aedHandled(state: SceneState): boolean {
  const s = state && state.aedStatus;
  return s === 'attached' || s === 'shock_delivered';
}

/**
 * Everyone still in the room, earliest joiner first. status 'left' means the
 * phone walked away: no role, and whatever they were doing gets backfilled.
 */
export function activeParticipants(state: SceneState): Participant[] {
  const list: Participant[] = Array.isArray(state && state.participants)
    ? (state.participants as Participant[])
    : [];
  return list
    .filter((p) => p && typeof p.id === 'string' && p.id.length > 0 && p.status !== 'left')
    .slice()
    .sort((a, b) => {
      const ja = typeof a.joinedAt === 'number' ? a.joinedAt : 0;
      const jb = typeof b.joinedAt === 'number' ? b.joinedAt : 0;
      if (ja !== jb) return ja - jb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Which jobs a room of `count` people should be covering, in the order they
 * get filled. Compressions first, always — everything else is a luxury.
 *
 *   1 person   compressions
 *   2 people   + call 911
 *   3 people   + fetch the AED  (or stage a swap, if the AED is already on)
 *   4 people   + stage a swap   (fatigue wrecks compressions after ~2 min)
 *   5 people   + hold the door
 *   6+         remainder clears space
 */
export function roleSequence(count: number, aedAlreadyHandled: boolean): RoleId[] {
  const seq: RoleId[] = [];
  if (count <= 0) return seq;
  seq.push('compressions');
  if (count >= 2) seq.push('call911');
  // AED already attached => that pair of hands is worth more staged for a swap.
  if (count >= 3) seq.push(aedAlreadyHandled ? 'swap_ready' : 'aed');
  // Never stage two swaps; if the AED substitution already made one, take the door.
  if (count >= 4) seq.push(seq.indexOf('swap_ready') !== -1 ? 'door' : 'swap_ready');
  if (count >= 5) seq.push(seq.indexOf('door') !== -1 ? 'crowd' : 'door');
  while (seq.length < count) seq.push('crowd');
  return seq;
}

function displayName(p: Participant | null | undefined): string {
  if (!p) return 'Someone';
  const n = typeof p.name === 'string' ? p.name.trim() : '';
  return n.length > 0 ? n : 'Responder';
}

function joinList(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] + ' and ' + parts[1];
  return parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
}

function makeAssignment(p: Participant, role: RoleId): Assignment {
  const script = roleScript(role);
  return {
    participantId: p.id,
    role,
    instruction: script.instruction,
    spoken: script.spoken,
    urgency: script.urgency,
  };
}

/** Why the person on the chest is the person on the chest. */
type CompressionReason =
  | 'continuity'
  | 'relief'
  | 'trained'
  | 'first'
  | 'no_relief'
  | 'none';

/**
 * The offline commander. Deterministic, total, and never throws.
 *
 * Priority, over every participant whose status is not 'left', earliest
 * joiner first:
 *   1. Someone is on compressions. Whoever is already doing it keeps doing it —
 *      continuity beats optimality, you never yank a working rescuer off the
 *      chest. Otherwise prefer a self-declared trained hand, else first on scene.
 *   2. Second person calls 911.
 *   3. Third fetches the AED — unless it is already attached or has shocked,
 *      in which case they stage for the swap instead.
 *   4. Fourth stages for the swap. Compression depth falls off badly after
 *      about two minutes, so the relief kneels down BEFORE they are needed.
 *   5. Fifth holds the door for the medics. Everyone after that clears space.
 *
 * Refinement the rules above imply but do not spell out: a compressor whose
 * status has gone 'struggling' is fading. If anyone else can take the chest,
 * they do, and the fading rescuer is not the one we stage for the next swap.
 */
export function deterministicPlan(state: SceneState): CommanderPlan {
  const safeState: SceneState = (state || {}) as SceneState;
  const code = typeof safeState.code === 'string' && safeState.code ? safeState.code : '----';
  const roster = activeParticipants(safeState);
  const count = roster.length;

  if (count === 0) {
    return {
      assignments: [],
      reasoning:
        'No responders are on scene yet. Nothing can be allocated until at least one pair of hands joins.',
      roomAnnouncement:
        'Nobody is on the chest. Start compressions and get anyone nearby onto join code ' +
        code +
        '.',
      model: 'deterministic',
      latencyMs: 0,
      degraded: true,
    };
  }

  const aedDone = aedHandled(safeState);
  const sequence = roleSequence(count, aedDone);

  // Working pool, consumed as slots are filled. Sorted earliest-joiner-first.
  const pool = roster.slice();
  const takeWhere = (pred: (p: Participant) => boolean): Participant | null => {
    for (let i = 0; i < pool.length; i++) {
      if (pred(pool[i])) return pool.splice(i, 1)[0];
    }
    return null;
  };

  // --- slot 0: the chest -----------------------------------------------------
  const incumbent = pool.find((p) => p.role === 'compressions') || null;
  let compressor: Participant | null = null;
  let relieved: Participant | null = null;
  let reason: CompressionReason = 'none';

  if (incumbent && incumbent.status !== 'struggling') {
    compressor = takeWhere((p) => p.id === incumbent.id);
    reason = 'continuity';
  } else if (incumbent) {
    // Fading. Relieve them only if somebody else can actually take over.
    const relief =
      takeWhere(
        (p) => p.id !== incumbent.id && p.status !== 'struggling' && p.role === 'swap_ready',
      ) ||
      takeWhere((p) => p.id !== incumbent.id && p.status !== 'struggling' && p.trained === true) ||
      takeWhere((p) => p.id !== incumbent.id && p.status !== 'struggling');
    if (relief) {
      compressor = relief;
      relieved = incumbent;
      reason = 'relief';
    } else {
      compressor = takeWhere((p) => p.id === incumbent.id);
      reason = 'no_relief';
    }
  }

  if (!compressor) {
    const trained = takeWhere((p) => p.status !== 'struggling' && p.trained === true);
    if (trained) {
      compressor = trained;
      reason = 'trained';
    } else {
      compressor = takeWhere((p) => p.status !== 'struggling') || takeWhere(() => true);
      reason = 'first';
    }
  }

  const slots: { role: RoleId; who: Participant | null }[] = sequence.map((role) => ({
    role,
    who: null,
  }));
  slots[0].who = compressor;

  // A fading rescuer is not the person we stage to go back on the chest.
  const eligible = (p: Participant, role: RoleId): boolean => {
    if (role !== 'swap_ready') return true;
    if (relieved && p.id === relieved.id) return false;
    return p.status !== 'struggling';
  };

  // Pass A — continuity. Anyone already doing a job we still need keeps it,
  // and we do this before general filling so a later slot cannot steal them.
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    slot.who = takeWhere((p) => p.role === slot.role && eligible(p, slot.role));
  }

  // Pass B — everyone left, in join order, into whatever is still open.
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.who) continue;
    slot.who = takeWhere((p) => eligible(p, slot.role)) || takeWhere(() => true);
  }

  const assignments: Assignment[] = [];
  const holder: Partial<Record<RoleId, Participant>> = {};
  const crowdMembers: Participant[] = [];
  for (const slot of slots) {
    if (!slot.who) continue;
    assignments.push(makeAssignment(slot.who, slot.role));
    if (slot.role === 'crowd') crowdMembers.push(slot.who);
    else if (!holder[slot.role]) holder[slot.role] = slot.who;
  }

  // --- reasoning: two plain sentences, named, shown live to the room ---------
  const compressorName = displayName(compressor);
  let first: string;
  switch (reason) {
    case 'continuity':
      first =
        compressorName +
        ' stays on compressions — they were already working, and continuity on the chest beats a tidier line-up.';
      break;
    case 'relief':
      first =
        compressorName +
        ' takes over compressions from ' +
        displayName(relieved) +
        ', who is fading; a tired rescuer loses depth fast.';
      break;
    case 'no_relief':
      first =
        compressorName +
        ' has to stay on compressions even though they are struggling, because there is nobody else free to take the chest.';
      break;
    case 'trained':
      first =
        compressorName +
        ' takes compressions — nobody was on the chest, and they are the first hand here claiming CPR training.';
      break;
    default:
      first =
        compressorName +
        ' takes compressions as the first person on scene; nobody was on the chest and nobody has claimed training.';
      break;
  }

  const clauses: string[] = [];
  if (holder.call911) clauses.push(displayName(holder.call911) + ' is on 911');
  if (holder.aed) clauses.push(displayName(holder.aed) + ' is running for the AED');
  if (holder.swap_ready) {
    clauses.push(
      displayName(holder.swap_ready) + ' is staged to swap in at the two-minute mark',
    );
  }
  if (holder.door) clauses.push(displayName(holder.door) + ' is holding the entrance for the medics');
  if (crowdMembers.length === 1) clauses.push(displayName(crowdMembers[0]) + ' is clearing space');
  else if (crowdMembers.length > 1) clauses.push(crowdMembers.length + ' more are clearing space');

  let second: string;
  if (clauses.length === 0) {
    second =
      'Nobody else is on scene, so the 911 call and the AED have to wait for more hands.';
  } else {
    second = joinList(clauses) + '.';
    second = second.charAt(0).toUpperCase() + second.slice(1);
  }
  if (aedDone && !holder.aed) {
    second += ' The AED is already on the patient, so nobody is being sent for one.';
  }

  // --- room announcement: only when a job we need is genuinely unfilled ------
  const wanted: RoleId[] = ['call911'];
  if (!aedDone) wanted.push('aed');
  wanted.push('swap_ready');
  const missing = wanted.filter((r) => !holder[r]);

  const askFor: Record<string, string> = {
    call911: 'someone to call 911',
    aed: 'someone to run for the AED',
    swap_ready: 'one more pair of hands to take over compressions',
  };
  const roomAnnouncement =
    missing.length === 0
      ? null
      : 'I need ' +
        missing.length +
        (missing.length === 1 ? ' more person: ' : ' more people: ') +
        joinList(missing.map((r) => askFor[r])) +
        '. Join on code ' +
        code +
        '.';

  return {
    assignments,
    reasoning: first + ' ' + second,
    roomAnnouncement,
    model: 'deterministic',
    latencyMs: 0,
    degraded: true,
  };
}
