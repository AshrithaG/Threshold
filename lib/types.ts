// ---------------------------------------------------------------------------
// Threshold shared contract. Every module in this app agrees on these shapes.
// Do not change a field name without updating lib/roles.ts, lib/scene.ts,
// app/api/commander/route.ts and components/*.
// ---------------------------------------------------------------------------

export type RoleId =
  | 'compressions'   // doing chest compressions right now
  | 'swap_ready'     // staged to take over compressions at the 2-minute mark
  | 'aed'            // retrieving / attaching the AED
  | 'call911'        // on the line with the dispatcher
  | 'door'           // meeting and guiding the medics in
  | 'crowd'          // clearing space, managing bystanders
  | 'unassigned';    // joined, waiting for a job

export const ALL_ROLES: RoleId[] = [
  'compressions', 'swap_ready', 'aed', 'call911', 'door', 'crowd', 'unassigned',
];

export type ParticipantStatus = 'active' | 'struggling' | 'left';

export interface Participant {
  id: string;                 // stable per device (localStorage uuid)
  name: string;               // "Responder 2" unless self-named
  joinedAt: number;           // ms since scene start
  role: RoleId;
  status: ParticipantStatus;
  lastSeen: number;           // ms since scene start
  isHost: boolean;
  /** self-declared, never verified — displayed as a claim, not a credential */
  trained: boolean;
}

export type SceneEventKind =
  | 'scene_start' | 'join' | 'leave' | 'assign' | 'reassign'
  | 'compressions_start' | 'compressions_stop' | 'rate_sample'
  | 'aed_enroute' | 'aed_attached' | 'shock' | 'ems_arrive'
  | 'offline' | 'online' | 'note';

export interface SceneEvent {
  t: number;                  // ms since scene start — the spine of the EMS handoff
  kind: SceneEventKind;
  actorId?: string;
  detail?: string;
  data?: Record<string, any>;
}

export type AedStatus = 'unknown' | 'enroute' | 'onscene' | 'attached' | 'shock_delivered';

export interface SceneState {
  code: string;               // 4-char join code, e.g. "4B2K"
  createdAt: number;          // wall-clock ms epoch, set by host
  participants: Participant[];
  events: SceneEvent[];
  compressionRate: number | null;   // live bpm from vision, null if not measuring
  compressionSamples: { t: number; bpm: number }[];
  aedStatus: AedStatus;
  online: boolean;            // false => degraded mode
  emsEtaSec: number | null;
}

export interface Assignment {
  participantId: string;
  role: RoleId;
  /** short text shown on that person's screen */
  instruction: string;
  /** what the phone says out loud — imperative, <= 18 words, no preamble */
  spoken: string;
  urgency: 'now' | 'soon';
}

export interface CommanderPlan {
  assignments: Assignment[];
  /** why this allocation — surfaced live to judges */
  reasoning: string;
  /** what the host phone shouts to the whole room, or null */
  roomAnnouncement: string | null;
  model: string;              // 'k2-horizon-...' | 'local:...' | 'deterministic'
  latencyMs: number;
  degraded: boolean;          // true when no LLM was reachable
}

export const ROLE_LABEL: Record<RoleId, string> = {
  compressions: 'COMPRESSIONS',
  swap_ready:   'NEXT ON COMPRESSIONS',
  aed:          'FETCH THE AED',
  call911:      'CALL 911',
  door:         'MEET THE MEDICS',
  crowd:        'CLEAR THE SPACE',
  unassigned:   'STAND BY',
};

export const ROLE_COLOR: Record<RoleId, string> = {
  compressions: '#ff3b30',
  swap_ready:   '#ff9f0a',
  aed:          '#0a84ff',
  call911:      '#30d158',
  door:         '#bf5af2',
  crowd:        '#8e8e93',
  unassigned:   '#48484a',
};
