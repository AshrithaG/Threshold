// ---------------------------------------------------------------------------
// app/api/commander/route.ts
//
// The reasoning hop. Secrets live here and only here — the browser never sees
// a key. This route ALWAYS answers 200 with a valid CommanderPlan:
//
//   IFM key + base present  -> K2 Horizon (OpenAI-compatible chat completions)
//   that failed, LOCAL set  -> the on-GPU offline brain, no auth header
//   anything else at all    -> deterministicPlan(state)
//
// A missing key, a dead endpoint, a 401, a hung socket or a model that returns
// prose instead of JSON must all land in the same place: a working plan.
// ---------------------------------------------------------------------------

import { ALL_ROLES } from '@/lib/types';
import type {
  Assignment,
  CommanderPlan,
  Participant,
  RoleId,
  SceneEvent,
  SceneState,
} from '@/lib/types';
import { aedHandled, deterministicPlan, isSingleOccupancy, roleScript } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Measured, not guessed: IFM/K2-Horizon-375B-A23B answers the compact contract
 * in roughly 5s (about 320 completion tokens at the throughput this endpoint
 * gives). 12s leaves headroom for a slow scene without stranding the room --
 * and the deterministic plan has already been applied by the time we start, so
 * this budget buys a better allocation, never the first one.
 */
const IFM_BUDGET_MS = 16000;
const LOCAL_BUDGET_MS = 5000;
const MAX_SPOKEN_WORDS = 18;
const MAX_INSTRUCTION_CHARS = 280;
const MAX_REASONING_CHARS = 420;
const MAX_ANNOUNCEMENT_CHARS = 220;
const RECENT_EVENT_COUNT = 12;

// ---------------------------------------------------------------------------
// The prompt. This is the product.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are THRESHOLD COMMANDER: the incident commander for a cardiac-arrest scene that is happening right now.',
  '',
  'A person has collapsed. Standing over them is a small crowd of bystanders. Most are untrained and frightened. Each one holds a phone that will speak your words out loud to that person and to nobody else. You give every pair of hands exactly one job, and you do it in under a second.',
  '',
  'DECIDE IN THIS ORDER. A higher rule always beats a lower one.',
  '1. Someone is on compressions at all times. Blood only moves while a chest is being pushed. An allocation that leaves the chest empty is never acceptable.',
  '2. CONTINUITY OUTRANKS OPTIMALITY. If a participant already has role "compressions", they keep it. Do not move a working rescuer to a job they would be better at. Do not swap two people because the pairing would be neater. Every reassignment costs seconds off the chest.',
  '3. Fatigue is real and it arrives fast. Compression depth degrades badly after roughly two minutes on the chest, so the relief kneels down BEFORE they are needed. As soon as a fourth pair of hands exists, stage one person as "swap_ready". If currentCompressorOnChestSec is above 110 and someone already holds "swap_ready", promote that person to "compressions" and move the tired rescuer to a light job ("crowd" or "door") — never back to "swap_ready".',
  '4. A participant with status "left" has walked away and their phone is gone. Give them no assignment at all, omit them entirely, and immediately backfill the job they were doing from the people who remain — compressions first.',
  '5. A participant with status "struggling" is failing at a physical job. Do not put them on, or leave them on, "compressions" or "swap_ready" while anyone else is available.',
  '6. Fill jobs in this order as headcount allows: compressions, call911, aed, swap_ready, door, then "crowd" for everyone left over. Skip "aed" when aedStatus is "attached" or "shock_delivered" — the AED is already on the patient, so that pair of hands is worth more as "swap_ready".',
  '7. "trained" is self-declared and unverified. It breaks ties for the chest when nobody is compressing yet. It never outranks rule 2.',
  '8. Exactly one person may hold each of compressions, call911, aed, swap_ready and door. "crowd" and "unassigned" may hold many.',
  '',
  // The voice-and-wording section that used to live here is gone on purpose.
  // The model no longer writes a single word that a bystander reads or hears --
  // that text is fixed in lib/roles.ts -- so describing how to write it was
  // both dead weight and an invitation to deliberate. Measured on
  // IFM/K2-Horizon-375B-A23B, every paragraph of instruction this prompt does
  // not contain is time the room does not spend waiting.
  '"why" is one or two plain sentences, naming people, explaining why this allocation and not another. It is displayed live to observers, so be honest about the trade-off you made.',
  '',
  '"room" is one line the host phone shouts to the whole room. Use it ONLY when a job that matters is unfilled and more hands would fix it. Otherwise return null.',
  '',
  'OUTPUT FORMAT. Return STRICT JSON and nothing else: no markdown fence, no commentary before or after, no reasoning outside the "why" field. Exactly this shape:',
  '{',
  '  "assign": { "<participantId>": "<role>", ... },',
  '  "why": "one or two sentences, under 300 characters, naming people and saying why THIS allocation",',
  '  "room": "a short sentence the host phone shouts to the whole room, or null"',
  '}',
  '',
  'You decide WHO DOES WHAT. You do not write the instructions themselves — the wording each phone shows and speaks is fixed, human-written, and reviewed. Never attempt to supply it. Your entire job is the allocation and the reason for it.',
  'Every participant whose status is not "left" must appear exactly once in "assign". Use ids exactly as given.',
  '',
  'WORKED EXAMPLE.',
  'Scene:',
  '{"code":"4B2K","elapsedSec":68,"compressionRate":88,"aedStatus":"unknown","currentCompressorOnChestSec":61,"participants":[{"id":"p1","name":"Dana","role":"compressions","status":"active","trained":false,"joinedAtSec":0},{"id":"p2","name":"Ravi","role":"call911","status":"active","trained":true,"joinedAtSec":12},{"id":"p3","name":"Kit","role":"unassigned","status":"active","trained":false,"joinedAtSec":40}],"recentEvents":[{"tSec":0,"kind":"scene_start"},{"tSec":40,"kind":"join","actorId":"p3"}]}',
  'Output:',
  '{"assign":{"p1":"compressions","p2":"call911","p3":"aed"},"why":"Dana keeps the chest even though Ravi is the one claiming training, because stopping compressions to swap costs more than the skill gap. Kit is the only free pair of hands, so they go for the AED.","room":"I need one more person to kneel ready and take over compressions. Join on code 4B2K."}',
  '',
  'Answer with the JSON object immediately. Do not narrate your reasoning outside it.',
].join('\n');

// ---------------------------------------------------------------------------
// State normalisation — the body arrived over the wire, trust nothing.
// ---------------------------------------------------------------------------

function normalizeState(raw: any): SceneState {
  const src = raw && typeof raw === 'object' ? raw : {};
  const participants: Participant[] = Array.isArray(src.participants)
    ? src.participants
        .filter((p: any) => p && typeof p === 'object' && typeof p.id === 'string' && p.id)
        .map((p: any) => ({
          id: String(p.id),
          name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Responder',
          joinedAt: Number.isFinite(p.joinedAt) ? Number(p.joinedAt) : 0,
          role: (ALL_ROLES as string[]).indexOf(p.role) !== -1 ? (p.role as RoleId) : 'unassigned',
          status:
            p.status === 'left' || p.status === 'struggling' || p.status === 'active'
              ? p.status
              : 'active',
          lastSeen: Number.isFinite(p.lastSeen) ? Number(p.lastSeen) : 0,
          isHost: p.isHost === true,
          trained: p.trained === true,
        }))
    : [];
  const events: SceneEvent[] = Array.isArray(src.events)
    ? src.events.filter((e: any) => e && typeof e === 'object' && typeof e.kind === 'string')
    : [];
  const aedStatus =
    src.aedStatus === 'enroute' ||
    src.aedStatus === 'onscene' ||
    src.aedStatus === 'attached' ||
    src.aedStatus === 'shock_delivered'
      ? src.aedStatus
      : 'unknown';
  return {
    code: typeof src.code === 'string' && src.code ? src.code : '----',
    createdAt: Number.isFinite(src.createdAt) ? Number(src.createdAt) : Date.now(),
    participants,
    events,
    compressionRate: Number.isFinite(src.compressionRate) ? Number(src.compressionRate) : null,
    compressionSamples: Array.isArray(src.compressionSamples) ? src.compressionSamples : [],
    aedStatus,
    online: src.online !== false,
    emsEtaSec: Number.isFinite(src.emsEtaSec) ? Number(src.emsEtaSec) : null,
  };
}

/**
 * joinedAt / lastSeen / event.t are documented as ms since scene start, but a
 * client that stamps Date.now() would send an epoch. Fold both into seconds
 * since scene start so the model never sees a 1.7-trillion timestamp.
 */
function relSeconds(state: SceneState, value: number): number {
  if (!Number.isFinite(value)) return 0;
  const ms = value > 1e12 ? value - state.createdAt : value;
  return Math.max(0, Math.round(ms / 1000));
}

function elapsedSeconds(state: SceneState): number {
  const ms = Date.now() - state.createdAt;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(Math.round(ms / 1000), 24 * 3600);
}

/** How long the current compressor has been on the chest, if we can tell. */
function compressorOnChestSec(state: SceneState): number | null {
  const compressor = state.participants.find(
    (p) => p.role === 'compressions' && p.status !== 'left',
  );
  if (!compressor) return null;
  let startedAt: number | null = null;
  for (const ev of state.events) {
    if (!ev || ev.actorId !== compressor.id) continue;
    const isStart =
      ev.kind === 'compressions_start' ||
      ((ev.kind === 'assign' || ev.kind === 'reassign') &&
        (ev.detail === 'compressions' ||
          (ev.data && (ev.data as any).role === 'compressions')));
    if (isStart && Number.isFinite(ev.t)) startedAt = Number(ev.t);
  }
  if (startedAt === null) return null;
  return Math.max(0, elapsedSeconds(state) - relSeconds(state, startedAt));
}

function sceneDigest(state: SceneState): string {
  const payload = {
    code: state.code,
    elapsedSec: elapsedSeconds(state),
    compressionRate: state.compressionRate,
    aedStatus: state.aedStatus,
    emsEtaSec: state.emsEtaSec,
    currentCompressorOnChestSec: compressorOnChestSec(state),
    participants: state.participants.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      status: p.status,
      trained: p.trained,
      joinedAtSec: relSeconds(state, p.joinedAt),
    })),
    recentEvents: state.events.slice(-RECENT_EVENT_COUNT).map((e) => {
      const out: Record<string, any> = { tSec: relSeconds(state, e.t), kind: e.kind };
      if (e.actorId) out.actorId = e.actorId;
      if (e.detail) out.detail = String(e.detail).slice(0, 120);
      return out;
    }),
  };
  try {
    return JSON.stringify(payload);
  } catch {
    return '{"participants":[]}';
  }
}

function buildMessages(state: SceneState): { role: string; content: string }[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'SCENE\n' +
        sceneDigest(state) +
        '\n\nAllocate every participant whose status is not "left". Return the JSON plan now.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

type ChatResult =
  | { kind: 'ok'; content: string }
  | { kind: 'http'; status: number }
  | { kind: 'err' };

function endpointOf(base: string): string {
  return base.replace(/\/+$/, '') + '/chat/completions';
}

function extractContent(data: any): string {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) return '';
  const content = choice.message ? choice.message.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part && part.text ? String(part.text) : ''))
      .join('');
  }
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

async function postChat(
  url: string,
  apiKey: string | null,
  model: string,
  messages: { role: string; content: string }[],
  jsonMode: boolean,
  timeoutMs: number,
  upstreamSignal: AbortSignal | null,
): Promise<ChatResult> {
  const ac = new AbortController();
  const ms = Math.max(600, Math.min(timeoutMs, 20000));
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {
      /* already settled */
    }
  }, ms);
  const onUpstreamAbort = () => {
    try {
      ac.abort();
    } catch {
      /* already settled */
    }
  };
  if (upstreamSignal) {
    if (upstreamSignal.aborted) onUpstreamAbort();
    else {
      try {
        upstreamSignal.addEventListener('abort', onUpstreamAbort);
      } catch {
        /* signal without listener support */
      }
    }
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = 'Bearer ' + apiKey;
    const body: Record<string, any> = {
      model,
      messages,
      temperature: 0.2,
      // Generous on purpose. This endpoint sometimes emits chain-of-thought
      // ahead of the object; parseLoose() scans past prose for the braces, so a
      // long preamble costs latency but still yields a plan. Being cut off
      // mid-object costs the plan entirely, which is the worse failure.
      max_tokens: 1600,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      try {
        await res.text();
      } catch {
        /* drain and ignore */
      }
      return { kind: 'http', status: res.status };
    }
    const data = await res.json();
    const content = extractContent(data);
    if (!content || !content.trim()) return { kind: 'err' };
    return { kind: 'ok', content };
  } catch {
    return { kind: 'err' };
  } finally {
    clearTimeout(timer);
    if (upstreamSignal) {
      try {
        upstreamSignal.removeEventListener('abort', onUpstreamAbort);
      } catch {
        /* nothing to remove */
      }
    }
  }
}

/**
 * One endpoint, one budget. Retries once WITHOUT response_format if the server
 * rejected the request outright (plenty of OpenAI-compatible servers 400 on
 * json_object), still inside the same deadline. Never throws.
 */
async function attempt(
  state: SceneState,
  url: string,
  apiKey: string | null,
  model: string,
  messages: { role: string; content: string }[],
  budgetMs: number,
  upstreamSignal: AbortSignal | null,
): Promise<CommanderPlan | null> {
  const started = Date.now();
  const deadline = started + budgetMs;
  let jsonMode = true;

  // Three passes, one shared deadline.
  //
  // The endpoint serving K2-Horizon-375B answers this prompt with the object
  // about half the time and with unstructured deliberation the other half,
  // regardless of response_format, guided_json or enable_thinking -- all three
  // were tried against the live endpoint and none of them bind. An unusable
  // answer is therefore an ordinary event, not an error, and the only thing
  // that converts it into a plan is asking again while there is still time.
  // Retrying on a bad body as well as on a bad status is what takes this from
  // roughly even odds to reliably landing inside the budget.
  for (let i = 0; i < 3; i++) {
    const remaining = deadline - Date.now();
    // A fresh attempt needs enough runway to be worth starting.
    if (remaining < 2500) break;
    if (upstreamSignal && upstreamSignal.aborted) break;

    const res = await postChat(url, apiKey, model, messages, jsonMode, remaining, upstreamSignal);

    if (res.kind === 'ok') {
      const plan = validatePlan(res.content, state, model, Date.now() - started);
      if (plan) return plan;
      // Prose, a truncated object, or an allocation that left the chest empty.
      // Nothing is wrong with the connection, so try again rather than give up.
      continue;
    }

    if (res.kind === 'http' && jsonMode && (res.status === 400 || res.status === 404 || res.status === 422)) {
      jsonMode = false;
      continue;
    }
    break;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Defensive parsing + validation
// ---------------------------------------------------------------------------

function stripFences(text: string): string {
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\s*/, '');
    const close = t.lastIndexOf('```');
    if (close !== -1) t = t.slice(0, close);
  }
  return t.trim();
}

function parseLoose(text: string): any | null {
  const cleaned = stripFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace scan */
  }
  const open = cleaned.indexOf('{');
  const close = cleaned.lastIndexOf('}');
  if (open !== -1 && close > open) {
    try {
      return JSON.parse(cleaned.slice(open, close + 1));
    } catch {
      return null;
    }
  }
  return null;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function sanitizeText(value: any, maxChars: number): string {
  if (typeof value !== 'string') return '';
  let t = value.replace(EMOJI, '');
  t = t.replace(/[*_`#>]+/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
    t = lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.trim();
  }
  return t.trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Turn whatever the model said into a plan we would be willing to speak into a
 * real room, or return null so the caller falls back to the deterministic plan.
 */
function validatePlan(
  rawText: string,
  state: SceneState,
  modelId: string,
  latencyMs: number,
): CommanderPlan | null {
  const parsed = parseLoose(rawText);
  if (!parsed || typeof parsed !== 'object') return null;

  // Two accepted shapes. The compact one is what the prompt asks for: an id ->
  // role map and nothing else. It exists because generating the instruction
  // prose costs roughly a thousand extra output tokens — about fifteen seconds
  // on a 375B — to reproduce text we already have, human-written, in
  // lib/roles.ts. Keeping the model out of the wording is also the safety
  // argument: it permutes a closed enum of roles and never authors a word that
  // a frightened stranger acts on.
  //
  // The verbose array shape is still parsed so that a model which ignores the
  // format, or an older client, degrades to a plan rather than to nothing.
  const compact =
    (parsed as any).assign && typeof (parsed as any).assign === 'object'
      ? ((parsed as any).assign as Record<string, unknown>)
      : null;

  const rawAssignments = compact
    ? Object.keys(compact).map((id) => ({ participantId: id, role: compact[id] }))
    : Array.isArray((parsed as any).assignments)
      ? (parsed as any).assignments
      : null;
  if (!rawAssignments || rawAssignments.length === 0) return null;

  const active = state.participants.filter((p) => p.status !== 'left');
  if (active.length === 0) return null;
  const byId = new Map<string, Participant>();
  for (const p of active) byId.set(p.id, p);

  const taken = new Set<RoleId>();
  const seen = new Set<string>();
  const assignments: Assignment[] = [];

  for (const raw of rawAssignments) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.participantId === 'string' ? raw.participantId.trim() : '';
    const person = byId.get(id);
    if (!person) continue;              // hallucinated id, or someone who left
    if (seen.has(id)) continue;         // model assigned the same person twice
    let role = (ALL_ROLES as string[]).indexOf(raw.role) !== -1 ? (raw.role as RoleId) : null;
    if (!role) continue;

    // One body per single-occupancy job. Extra compressors become the staged
    // swap; every other duplicate falls back to clearing space.
    if (isSingleOccupancy(role) && taken.has(role)) {
      if (role === 'compressions' && !taken.has('swap_ready')) role = 'swap_ready';
      else role = 'crowd';
    }

    const script = roleScript(role);
    let instruction = sanitizeText(raw.instruction, MAX_INSTRUCTION_CHARS);
    if (instruction.length < 12) instruction = script.instruction;
    let spoken = sanitizeText(raw.spoken, 200);
    if (spoken.length < 6 || wordCount(spoken) > MAX_SPOKEN_WORDS) spoken = script.spoken;
    const urgency: 'now' | 'soon' =
      raw.urgency === 'now' || raw.urgency === 'soon' ? raw.urgency : script.urgency;

    seen.add(id);
    if (isSingleOccupancy(role)) taken.add(role);
    assignments.push({ participantId: person.id, role, instruction, spoken, urgency });
  }

  // Nobody on the chest is not a plan, it is a failure. Hand it to the fallback.
  if (!taken.has('compressions')) return null;
  // Half the room unallocated means the model lost the plot.
  if (assignments.length * 2 < active.length) return null;

  // Anyone the model forgot keeps the job they already had, unless someone else
  // now holds it, in which case they take the highest-value opening left.
  const wantAed = !aedHandled(state);
  const backfillOrder: RoleId[] = wantAed
    ? ['call911', 'aed', 'swap_ready', 'door']
    : ['call911', 'swap_ready', 'door'];
  for (const person of active) {
    if (seen.has(person.id)) continue;
    let role: RoleId = person.role;
    const blocked =
      role === 'unassigned' || (isSingleOccupancy(role) && taken.has(role)) || (role === 'aed' && !wantAed);
    if (blocked) {
      role = 'crowd';
      for (const candidate of backfillOrder) {
        if (!taken.has(candidate)) {
          role = candidate;
          break;
        }
      }
    }
    const script = roleScript(role);
    if (isSingleOccupancy(role)) taken.add(role);
    seen.add(person.id);
    assignments.push({
      participantId: person.id,
      role,
      instruction: script.instruction,
      spoken: script.spoken,
      urgency: script.urgency,
    });
  }

  let reasoning = sanitizeText((parsed as any).why ?? (parsed as any).reasoning, MAX_REASONING_CHARS);
  if (reasoning.length < 12) reasoning = deterministicPlan(state).reasoning;
  const announcement = sanitizeText(
    (parsed as any).room ?? (parsed as any).roomAnnouncement,
    MAX_ANNOUNCEMENT_CHARS,
  );

  return {
    assignments,
    reasoning,
    roomAnnouncement: announcement.length >= 8 ? announcement : null,
    model: modelId,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    degraded: false,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

function envValue(name: string): string {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

async function buildPlan(
  state: SceneState,
  signal: AbortSignal | null,
  /**
   * The scene says the internet is gone. Phones reach this server over the
   * local network, so the fetch below would still succeed — and the demo would
   * be a lie. Skipping the remote hop here puts the request down the exact code
   * path a real outage produces: local model if one is loaded, deterministic
   * commander otherwise. Nothing else about the request changes.
   */
  offline: boolean,
): Promise<CommanderPlan> {
  const apiKey = offline ? '' : envValue('IFM_API_KEY');
  const baseUrl = offline ? '' : envValue('IFM_BASE_URL');
  const model = envValue('IFM_MODEL') || 'k2-horizon';
  const localUrl = envValue('LOCAL_MODEL_URL');
  const localName = envValue('LOCAL_MODEL_NAME') || 'k2-horizon-0.9b';

  // Nothing configured at all: the deterministic commander is the product.
  if (!apiKey || !baseUrl) {
    if (!localUrl) return deterministicPlan(state);
  }

  const messages = buildMessages(state);

  if (apiKey && baseUrl) {
    const plan = await attempt(
      state,
      endpointOf(baseUrl),
      apiKey,
      model,
      messages,
      IFM_BUDGET_MS,
      signal,
    );
    if (plan) return plan;
  }

  // The on-GPU offline brain. No auth header, and only if the room is still
  // waiting on us.
  if (localUrl && !(signal && signal.aborted)) {
    const plan = await attempt(
      state,
      endpointOf(localUrl),
      null,
      localName,
      messages,
      LOCAL_BUDGET_MS,
      signal,
    );
    if (plan) return { ...plan, model: 'local:' + localName };
  }

  return deterministicPlan(state);
}

function jsonResponse(plan: CommanderPlan): Response {
  return new Response(JSON.stringify(plan), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function POST(req: Request): Promise<Response> {
  let state: SceneState;
  try {
    const body = await req.json();
    const inner = body && typeof body === 'object' && body.state ? body.state : body;
    state = normalizeState(inner);
  } catch {
    state = normalizeState(null);
  }

  // `online: false` is the host's network-loss switch; treat a genuinely
  // absent flag as online so an older client still works.
  const offline = state.online === false;

  let plan: CommanderPlan;
  try {
    plan = await buildPlan(state, req.signal || null, offline);
  } catch {
    plan = deterministicPlan(state);
  }

  try {
    return jsonResponse(plan);
  } catch {
    return jsonResponse(deterministicPlan(normalizeState(null)));
  }
}

/** Health probe for the demo rig: which brain is wired up? No secrets leave. */
export async function GET(): Promise<Response> {
  const body = {
    ok: true,
    ifmConfigured: Boolean(envValue('IFM_API_KEY') && envValue('IFM_BASE_URL')),
    ifmModel: envValue('IFM_MODEL') || null,
    localConfigured: Boolean(envValue('LOCAL_MODEL_URL')),
    localModel: envValue('LOCAL_MODEL_URL') ? envValue('LOCAL_MODEL_NAME') || 'k2-horizon-0.9b' : null,
    fallback: 'deterministic',
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
