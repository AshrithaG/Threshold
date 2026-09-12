'use client';

// ---------------------------------------------------------------------------
// components/HandoffCard.tsx
//
// THE EMS HANDOFF RECORD.
//
// Every number on this card is derived from state.events and
// state.compressionSamples. Nothing is estimated, interpolated, smoothed or
// inferred. If the scene did not produce the data, the cell reads "—". That
// rule is the whole point: a handoff sheet that guesses is worse than no sheet.
//
// This is a simulation record. It is not a medical device and carries no
// clinical guidance.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROLE_COLOR, type SceneEvent, type SceneEventKind, type SceneState } from '@/lib/types';

const DASH = '—';

/** A pause longer than this between rate samples is logged as an interruption. */
const INTERRUPTION_MS = 10_000;

/** The rate band the metronome paces to. */
const BAND_LOW = 100;
const BAND_HIGH = 120;

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(v: any): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** mm:ss, always padded. Negative and non-finite inputs collapse to 00:00. */
function fmtDuration(ms: number | null | undefined): string {
  const n = toFiniteNumber(ms);
  if (n === null) return DASH;
  const total = Math.max(0, Math.floor(n / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtOrDash(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? DASH : fmtDuration(ms);
}

function fmtInt(n: number | null | undefined, suffix = ''): string {
  const v = toFiniteNumber(n);
  if (v === null) return DASH;
  return `${Math.round(v)}${suffix}`;
}

/** Ensures a fragment reads as one sentence without doubling punctuation. */
function sentence(s: string): string {
  const t = (s || '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// ---------------------------------------------------------------------------
// event language — every SceneEventKind maps to plain clinical prose
// ---------------------------------------------------------------------------

function describeEvent(ev: SceneEvent, who: string): string {
  const detail = typeof ev?.detail === 'string' ? ev.detail.trim() : '';
  const kind: SceneEventKind = ev?.kind;

  switch (kind) {
    case 'scene_start':
      return sentence(detail || 'Scene opened. Bystander response begins');

    case 'join':
      return sentence(`${who || 'A responder'} joined the scene${detail ? ` (${detail})` : ''}`);

    case 'leave':
      return sentence(`${who || 'A responder'} left the scene${detail ? ` (${detail})` : ''}`);

    case 'assign':
      return sentence(
        `Role assigned${who ? ` to ${who}` : ''}${detail ? `: ${detail}` : ''}`,
      );

    case 'reassign':
      return sentence(
        `Roles reallocated${detail ? `: ${detail}` : ' by the commander'}`,
      );

    case 'compressions_start':
      return sentence(`Chest compressions started${who ? ` by ${who}` : ''}${detail ? ` (${detail})` : ''}`);

    case 'compressions_stop':
      return sentence(`Chest compressions paused${who ? ` by ${who}` : ''}${detail ? ` (${detail})` : ''}`);

    case 'rate_sample': {
      const bpm = toFiniteNumber(ev?.data?.bpm);
      if (bpm !== null) return `Compression rate measured at ${Math.round(bpm)} per minute.`;
      return sentence(detail || 'Compression rate sample recorded');
    }

    case 'aed_enroute':
      return sentence(
        `AED retrieval underway${who ? ` (${who})` : ''}${detail ? `: ${detail}` : ''}`,
      );

    case 'aed_attached':
      return sentence(`AED pads attached${who ? ` by ${who}` : ''}${detail ? ` (${detail})` : ''}`);

    case 'shock':
      return sentence(`Shock delivered by AED${detail ? ` (${detail})` : ''}`);

    case 'ems_arrive':
      return sentence(`EMS crew on scene${detail ? `: ${detail}` : '. Handoff begins'}`);

    case 'offline':
      return sentence(detail || 'Network lost. Device continued in standalone mode');

    case 'online':
      return sentence(detail || 'Network restored. Scene state resynchronised');

    case 'note':
      return sentence(detail || 'Note recorded');

    default:
      return sentence(detail || String(kind || 'Event recorded'));
  }
}

/** Dot colour per event family, drawn from the shared role palette. */
function eventColor(kind: SceneEventKind): string {
  switch (kind) {
    case 'compressions_start':
    case 'compressions_stop':
      return ROLE_COLOR.compressions;
    case 'aed_enroute':
    case 'aed_attached':
    case 'shock':
      return ROLE_COLOR.aed;
    case 'assign':
    case 'reassign':
      return ROLE_COLOR.swap_ready;
    case 'join':
    case 'leave':
      return ROLE_COLOR.crowd;
    case 'ems_arrive':
      return ROLE_COLOR.door;
    case 'offline':
    case 'online':
      return ROLE_COLOR.unassigned;
    default:
      return '#5a5a60';
  }
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

interface Metrics {
  sceneEndMs: number;
  responders: number;
  trainedCount: number;
  events: SceneEvent[];
  rateSampleEventCount: number;

  timeToFirstCompressionsMs: number | null;
  totalCompressionMs: number | null;
  compressionFractionPct: number | null;

  interruptionCount: number | null;
  interruptionTotalMs: number | null;

  sampleCount: number;
  meanBpm: number | null;
  medianBpm: number | null;
  inBandPct: number | null;

  timeToAedAttachedMs: number | null;
  timeToShockMs: number | null;
  timeToEmsMs: number | null;
}

const EMPTY_METRICS: Metrics = {
  sceneEndMs: 0,
  responders: 0,
  trainedCount: 0,
  events: [],
  rateSampleEventCount: 0,
  timeToFirstCompressionsMs: null,
  totalCompressionMs: null,
  compressionFractionPct: null,
  interruptionCount: null,
  interruptionTotalMs: null,
  sampleCount: 0,
  meanBpm: null,
  medianBpm: null,
  inBandPct: null,
  timeToAedAttachedMs: null,
  timeToShockMs: null,
  timeToEmsMs: null,
};

function computeMetrics(state: SceneState | null | undefined, nowMs: number | null): Metrics {
  if (!state || typeof state !== 'object') return EMPTY_METRICS;

  // --- normalise inputs -----------------------------------------------------
  const rawEvents = Array.isArray(state.events) ? state.events : [];
  const events = rawEvents
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({ ...e, t: Math.max(0, toFiniteNumber(e.t) ?? 0) }))
    .sort((a, b) => a.t - b.t);

  const rawSamples = Array.isArray(state.compressionSamples) ? state.compressionSamples : [];
  const samples = rawSamples
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ t: Math.max(0, toFiniteNumber(s.t) ?? 0), bpm: toFiniteNumber(s.bpm) }))
    .filter((s) => s.bpm !== null && s.bpm > 0 && s.bpm < 400)
    .sort((a, b) => a.t - b.t) as { t: number; bpm: number }[];

  const participants = Array.isArray(state.participants) ? state.participants : [];

  // --- how long has this scene been running --------------------------------
  const createdAt = toFiniteNumber(state.createdAt);
  const lastEventT = events.length ? events[events.length - 1].t : 0;
  const lastSampleT = samples.length ? samples[samples.length - 1].t : 0;
  const wallElapsed =
    nowMs !== null && createdAt !== null && createdAt > 0 ? Math.max(0, nowMs - createdAt) : 0;
  const sceneEndMs = Math.max(wallElapsed, lastEventT, lastSampleT, 0);

  // --- windows during which compressions were nominally underway -----------
  const intervals: [number, number][] = [];
  let open: number | null = null;
  for (const ev of events) {
    if (ev.kind === 'compressions_start') {
      if (open === null) open = ev.t;
    } else if (ev.kind === 'compressions_stop') {
      if (open !== null) {
        intervals.push([open, Math.max(open, ev.t)]);
        open = null;
      }
    }
  }
  if (open !== null) intervals.push([open, Math.max(open, sceneEndMs)]);

  // No explicit start/stop logging, but the camera saw compressions: treat the
  // span of measurements as the single window rather than reporting nothing.
  let derivedFromSamples = false;
  if (intervals.length === 0 && samples.length >= 2) {
    intervals.push([samples[0].t, samples[samples.length - 1].t]);
    derivedFromSamples = true;
  }

  // --- time to first compressions ------------------------------------------
  const firstStart = events.find((e) => e.kind === 'compressions_start');
  let timeToFirstCompressionsMs: number | null = null;
  if (firstStart) timeToFirstCompressionsMs = firstStart.t;
  else if (samples.length) timeToFirstCompressionsMs = samples[0].t;

  // --- total compression time ----------------------------------------------
  let totalCompressionMs: number | null = null;
  if (intervals.length) {
    let sum = 0;
    for (const [a, b] of intervals) sum += Math.max(0, b - a);
    totalCompressionMs = sum;
  }

  const compressionFractionPct =
    totalCompressionMs !== null && sceneEndMs > 0
      ? Math.max(0, Math.min(100, (totalCompressionMs / sceneEndMs) * 100))
      : null;

  // --- interruptions: gaps > 10s between rate samples inside a window ------
  let interruptionCount: number | null = null;
  let interruptionTotalMs: number | null = null;
  if (samples.length >= 2) {
    let count = 0;
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
      const gap = samples[i].t - samples[i - 1].t;
      if (gap <= INTERRUPTION_MS) continue;
      const mid = samples[i - 1].t + gap / 2;
      const insideWindow =
        intervals.length === 0 || derivedFromSamples
          ? true
          : intervals.some(([a, b]) => mid >= a && mid <= b);
      if (!insideWindow) continue;
      count += 1;
      total += gap;
    }
    interruptionCount = count;
    interruptionTotalMs = total;
  }

  // --- rate statistics ------------------------------------------------------
  const bpms = samples.map((s) => s.bpm);
  let meanBpm: number | null = null;
  let medianBpm: number | null = null;
  let inBandPct: number | null = null;
  if (bpms.length) {
    meanBpm = bpms.reduce((a, b) => a + b, 0) / bpms.length;
    const sortedBpm = [...bpms].sort((a, b) => a - b);
    const mid = Math.floor(sortedBpm.length / 2);
    medianBpm =
      sortedBpm.length % 2 === 1 ? sortedBpm[mid] : (sortedBpm[mid - 1] + sortedBpm[mid]) / 2;
    const inBand = bpms.filter((b) => b >= BAND_LOW && b <= BAND_HIGH).length;
    inBandPct = (inBand / bpms.length) * 100;
  }

  // --- milestone timestamps -------------------------------------------------
  const firstOf = (kind: SceneEventKind): number | null => {
    const hit = events.find((e) => e.kind === kind);
    return hit ? hit.t : null;
  };

  return {
    sceneEndMs,
    responders: participants.length,
    trainedCount: participants.filter((p) => p && p.trained === true).length,
    events,
    rateSampleEventCount: events.filter((e) => e.kind === 'rate_sample').length,
    timeToFirstCompressionsMs,
    totalCompressionMs,
    compressionFractionPct,
    interruptionCount,
    interruptionTotalMs,
    sampleCount: samples.length,
    meanBpm,
    medianBpm,
    inBandPct,
    timeToAedAttachedMs: firstOf('aed_attached'),
    timeToShockMs: firstOf('shock'),
    timeToEmsMs: firstOf('ems_arrive'),
  };
}

// ---------------------------------------------------------------------------
// clipboard / download
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path — often a permissions or http:// issue */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export interface HandoffCardProps {
  state: SceneState | null | undefined;
}

export default function HandoffCard({ state }: HandoffCardProps) {
  // Wall clock is resolved after mount: the server's timezone is not the
  // responder's, and a hydration mismatch on the handoff sheet looks like a bug.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [startLabel, setStartLabel] = useState<string>(DASH);
  const [dateLabel, setDateLabel] = useState<string>(DASH);
  const [showSamples, setShowSamples] = useState(false);
  const [toast, setToast] = useState<string>('');

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const createdAt = toFiniteNumber(state?.createdAt);

  useEffect(() => {
    if (createdAt === null || createdAt <= 0) {
      setStartLabel(DASH);
      setDateLabel(DASH);
      return;
    }
    try {
      const d = new Date(createdAt);
      setStartLabel(
        d.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      );
      setDateLabel(
        d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
      );
    } catch {
      setStartLabel(DASH);
      setDateLabel(DASH);
    }
  }, [createdAt]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const m = useMemo(() => computeMetrics(state, nowMs), [state, nowMs]);

  const nameFor = useCallback(
    (id?: string): string => {
      if (!id) return '';
      const list = Array.isArray(state?.participants) ? state!.participants : [];
      const p = list.find((x) => x && x.id === id);
      if (!p) return '';
      const n = typeof p.name === 'string' ? p.name.trim() : '';
      return n || 'Responder';
    },
    [state],
  );

  const visibleEvents = useMemo(
    () => (showSamples ? m.events : m.events.filter((e) => e.kind !== 'rate_sample')),
    [m.events, showSamples],
  );

  const plainText = useMemo(() => {
    const code = state?.code || DASH;
    const L: string[] = [];
    L.push(`THRESHOLD SCENE RECORD  ${code}`);
    L.push('SIMULATION RECORD. NOT A MEDICAL DEVICE. NOT FOR CLINICAL USE.');
    L.push('');
    L.push(`Start          ${startLabel}  ${dateLabel}`);
    L.push(`Elapsed        ${fmtDuration(m.sceneEndMs)}`);
    L.push(`Responders     ${m.responders} (${m.trainedCount} self-reported trained)`);
    L.push(`Connectivity   ${state?.online === false ? 'degraded / standalone' : 'networked'}`);
    L.push('');
    L.push('CPR SUMMARY');
    L.push(`  Time to first compressions   ${fmtOrDash(m.timeToFirstCompressionsMs)}`);
    L.push(`  Total compression time       ${fmtOrDash(m.totalCompressionMs)}`);
    L.push(
      `  Compression fraction         ${
        m.compressionFractionPct === null ? DASH : `${Math.round(m.compressionFractionPct)}%`
      }`,
    );
    L.push(
      `  Interruptions over 10s       ${
        m.interruptionCount === null
          ? DASH
          : `${m.interruptionCount} (total ${fmtDuration(m.interruptionTotalMs)})`
      }`,
    );
    L.push(`  Mean rate                    ${m.meanBpm === null ? DASH : `${Math.round(m.meanBpm)} bpm`}`);
    L.push(
      `  Median rate                  ${m.medianBpm === null ? DASH : `${Math.round(m.medianBpm)} bpm`}`,
    );
    L.push(
      `  Within ${BAND_LOW}-${BAND_HIGH} bpm            ${
        m.inBandPct === null ? DASH : `${Math.round(m.inBandPct)}% of ${m.sampleCount} samples`
      }`,
    );
    L.push(`  AED attached                 ${fmtOrDash(m.timeToAedAttachedMs)}`);
    L.push(`  Shock delivered              ${fmtOrDash(m.timeToShockMs)}`);
    L.push(`  EMS on scene                 ${fmtOrDash(m.timeToEmsMs)}`);
    L.push('');
    L.push('TIMELINE');
    if (m.events.length === 0) {
      L.push('  (no events recorded)');
    } else {
      for (const ev of m.events) {
        L.push(`  ${fmtDuration(ev.t)}  ${describeEvent(ev, nameFor(ev.actorId))}`);
      }
    }
    L.push('');
    L.push('Rate figures are camera-derived estimates from a bystander phone.');
    L.push('Simulation record. Not a medical device. Not for clinical use.');
    return L.join('\n');
  }, [state, startLabel, dateLabel, m, nameFor]);

  const onCopy = useCallback(async () => {
    const ok = await copyToClipboard(plainText);
    setToast(ok ? 'Handoff copied to clipboard' : 'Copy blocked by the browser. Select the text manually.');
  }, [plainText]);

  const onDownload = useCallback(() => {
    try {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const payload = {
        exportedAt: new Date().toISOString(),
        disclaimer:
          'Simulation record produced by Threshold. Not a medical device. Not for clinical use.',
        state: state ?? null,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `threshold-${state?.code || 'scene'}-${fileStamp(new Date())}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* already revoked */
        }
      }, 2000);
      setToast('Scene JSON downloaded');
    } catch {
      setToast('Download blocked by the browser');
    }
  }, [state]);

  const rateTone = (value: number | null): string => {
    if (value === null) return '';
    return value >= BAND_LOW && value <= BAND_HIGH ? 'hc-good' : 'hc-warn';
  };

  return (
    <article className="hc" aria-label="EMS handoff record">
      <style>{CSS}</style>

      <header className="hc-head">
        <div className="hc-headrow">
          <div className="hc-idblock">
            <div className="hc-kicker">EMS Handoff Record</div>
            <div className="hc-code">{state?.code || DASH}</div>
          </div>
          <div className="hc-clockblock">
            <div className="hc-elapsed">{fmtDuration(m.sceneEndMs)}</div>
            <div className="hc-kicker hc-right">Total elapsed</div>
          </div>
        </div>

        <dl className="hc-meta">
          <div className="hc-metaitem">
            <dt>Start</dt>
            <dd className="hc-mono">{startLabel}</dd>
          </div>
          <div className="hc-metaitem">
            <dt>Date</dt>
            <dd className="hc-mono">{dateLabel}</dd>
          </div>
          <div className="hc-metaitem">
            <dt>Responders</dt>
            <dd className="hc-mono">{m.responders}</dd>
          </div>
          <div className="hc-metaitem">
            <dt>Trained (self-reported)</dt>
            <dd className="hc-mono">{m.trainedCount}</dd>
          </div>
          {state?.online === false ? (
            <div className="hc-metaitem">
              <dt>Link</dt>
              <dd className="hc-mono hc-warn">STANDALONE</dd>
            </div>
          ) : null}
        </dl>

        <div className="hc-sim" role="note">
          <span className="hc-simdot" aria-hidden="true" />
          SIMULATION {DASH} CALL 911
        </div>
      </header>

      <section className="hc-section" aria-label="Summary metrics">
        <h3 className="hc-sech">Resuscitation summary</h3>
        <div className="hc-grid">
          <Stat label="To first compressions" value={fmtOrDash(m.timeToFirstCompressionsMs)} />
          <Stat label="Total compression time" value={fmtOrDash(m.totalCompressionMs)} />
          <Stat
            label="Compression fraction"
            value={m.compressionFractionPct === null ? DASH : `${Math.round(m.compressionFractionPct)}%`}
            note={m.totalCompressionMs === null ? 'no compression windows logged' : 'of scene elapsed'}
          />
          <Stat
            label="Interruptions over 10s"
            value={m.interruptionCount === null ? DASH : String(m.interruptionCount)}
            note={
              m.interruptionCount === null
                ? 'needs two or more rate samples'
                : `total ${fmtDuration(m.interruptionTotalMs)} hands off`
            }
            tone={m.interruptionCount !== null && m.interruptionCount > 0 ? 'hc-warn' : ''}
          />
          <Stat
            label="Mean rate"
            value={m.meanBpm === null ? DASH : `${Math.round(m.meanBpm)}`}
            unit={m.meanBpm === null ? '' : 'bpm'}
            tone={rateTone(m.meanBpm)}
          />
          <Stat
            label="Median rate"
            value={m.medianBpm === null ? DASH : `${Math.round(m.medianBpm)}`}
            unit={m.medianBpm === null ? '' : 'bpm'}
            tone={rateTone(m.medianBpm)}
          />
          <Stat
            label={`In ${BAND_LOW}-${BAND_HIGH} band`}
            value={m.inBandPct === null ? DASH : `${Math.round(m.inBandPct)}%`}
            note={m.sampleCount ? `${m.sampleCount} camera samples` : 'no camera samples'}
          />
          <Stat label="AED attached" value={fmtOrDash(m.timeToAedAttachedMs)} />
          <Stat label="Shock delivered" value={fmtOrDash(m.timeToShockMs)} />
          <Stat label="EMS on scene" value={fmtOrDash(m.timeToEmsMs)} />
        </div>
        <p className="hc-caveat">
          Rate figures are camera-derived estimates from a bystander phone, not a monitor. A cell
          reads {DASH} when the scene produced no data for it; no value here is inferred.
        </p>
      </section>

      <section className="hc-section" aria-label="Event timeline">
        <div className="hc-sechrow">
          <h3 className="hc-sech">Timeline</h3>
          {m.rateSampleEventCount > 0 ? (
            <button
              type="button"
              className="hc-toggle"
              onClick={() => setShowSamples((v) => !v)}
              aria-pressed={showSamples}
            >
              {showSamples ? 'Hide' : 'Show'} {m.rateSampleEventCount} rate samples
            </button>
          ) : null}
        </div>

        {visibleEvents.length === 0 ? (
          <p className="hc-empty">No events recorded for this scene.</p>
        ) : (
          <ol className="hc-timeline">
            {visibleEvents.map((ev, i) => (
              <li className="hc-tl" key={`${ev.t}-${ev.kind}-${i}`}>
                <span className="hc-tldot" style={{ background: eventColor(ev.kind) }} aria-hidden="true" />
                <time className="hc-tlt hc-mono">{fmtDuration(ev.t)}</time>
                <span className="hc-tltext">{describeEvent(ev, nameFor(ev.actorId))}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="hc-actions">
        <button type="button" className="hc-btn hc-btn-primary" onClick={onCopy}>
          Copy handoff
        </button>
        <button type="button" className="hc-btn" onClick={onDownload}>
          Download JSON
        </button>
      </div>

      <div className="hc-toast" role="status" aria-live="polite">
        {toast ? <span>{toast}</span> : null}
      </div>

      <footer className="hc-foot">
        Simulation record. Not a medical device. Not for clinical use.
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  unit,
  note,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: string;
}) {
  return (
    <div className="hc-stat">
      <div className="hc-statlabel">{label}</div>
      <div className={`hc-statvalue hc-mono ${tone || ''}`}>
        {value}
        {unit ? <span className="hc-statunit">{unit}</span> : null}
      </div>
      {note ? <div className="hc-statnote">{note}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// styles — scoped by the hc- prefix so this card drops into any page
// ---------------------------------------------------------------------------

const CSS = `
.hc {
  --hc-bg: #0a0a0b;
  --hc-panel: #121214;
  --hc-line: #26262a;
  --hc-text: #f5f5f7;
  --hc-dim: #8e8e93;
  --hc-alert: #ff453a;
  --hc-good: #30d158;
  --hc-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  box-sizing: border-box;
  display: block;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 18px 16px 20px;
  background: var(--hc-bg);
  color: var(--hc-text);
  border: 1px solid var(--hc-line);
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.hc *, .hc *::before, .hc *::after { box-sizing: border-box; }
.hc-mono { font-family: var(--hc-mono); font-variant-numeric: tabular-nums; }
.hc-good { color: var(--hc-good); }
.hc-warn { color: var(--hc-alert); }

.hc-head { border-bottom: 1px solid var(--hc-line); padding-bottom: 14px; }
.hc-headrow {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.hc-kicker {
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--hc-dim); font-weight: 600;
}
.hc-right { text-align: right; }
.hc-code {
  font-family: var(--hc-mono);
  font-size: 44px; line-height: 1.05; font-weight: 600;
  letter-spacing: 0.14em; margin-top: 4px;
}
.hc-clockblock { text-align: right; }
.hc-elapsed {
  font-family: var(--hc-mono);
  font-size: 30px; line-height: 1.1; font-weight: 500;
  letter-spacing: 0.04em; color: var(--hc-text);
}

.hc-meta {
  display: flex; flex-wrap: wrap; gap: 6px 22px;
  margin: 14px 0 0; padding: 0;
}
.hc-metaitem { margin: 0; }
.hc-meta dt {
  font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--hc-dim); font-weight: 600;
}
.hc-meta dd { margin: 2px 0 0; font-size: 14px; letter-spacing: 0.02em; }

.hc-sim {
  display: flex; align-items: center; gap: 8px;
  margin-top: 14px; padding: 9px 11px;
  border: 1px solid var(--hc-alert);
  border-left-width: 3px;
  border-radius: 4px;
  background: rgba(255, 69, 58, 0.08);
  color: var(--hc-alert);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
}
.hc-simdot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--hc-alert); flex: 0 0 auto;
  animation: hc-pulse 1.6s ease-in-out infinite;
}
@keyframes hc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .hc-simdot { animation: none; } }

.hc-section { padding-top: 18px; }
.hc-sech {
  margin: 0 0 12px; font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--hc-dim);
}
.hc-sechrow {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
}
.hc-sechrow .hc-sech { margin-bottom: 12px; }

.hc-grid {
  display: grid; gap: 1px;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  background: var(--hc-line);
  border: 1px solid var(--hc-line);
  border-radius: 4px;
  overflow: hidden;
}
.hc-stat { background: var(--hc-panel); padding: 11px 12px 12px; min-height: 78px; }
.hc-statlabel {
  font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--hc-dim); font-weight: 600; line-height: 1.35;
}
.hc-statvalue {
  margin-top: 7px; font-size: 25px; line-height: 1.1;
  font-weight: 500; letter-spacing: 0.02em;
}
.hc-statunit {
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--hc-dim); margin-left: 5px; font-weight: 600;
}
.hc-statnote { margin-top: 5px; font-size: 10px; color: var(--hc-dim); line-height: 1.35; }

.hc-caveat { margin: 10px 0 0; font-size: 11px; color: var(--hc-dim); line-height: 1.5; }

.hc-toggle {
  appearance: none; -webkit-appearance: none;
  background: transparent; color: var(--hc-dim);
  border: 1px solid var(--hc-line); border-radius: 4px;
  padding: 8px 11px; min-height: 36px;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.12em; text-transform: uppercase;
  cursor: pointer; margin-bottom: 12px;
  font-family: inherit;
}
.hc-toggle:hover { color: var(--hc-text); border-color: #3a3a40; }

.hc-timeline {
  list-style: none; margin: 0; padding: 0 0 0 2px;
  max-height: 46vh; min-height: 120px; overflow-y: auto;
  border-top: 1px solid var(--hc-line);
  -webkit-overflow-scrolling: touch;
}
.hc-tl {
  position: relative;
  display: grid;
  grid-template-columns: 14px 56px 1fr;
  align-items: baseline;
  gap: 8px;
  padding: 8px 4px 8px 0;
  border-bottom: 1px solid rgba(38, 38, 42, 0.6);
}
.hc-tl:last-child { border-bottom: none; }
.hc-tldot {
  width: 7px; height: 7px; border-radius: 50%;
  margin-left: 3px; align-self: center;
}
.hc-tlt { font-size: 12px; color: var(--hc-dim); letter-spacing: 0.04em; }
.hc-tltext { font-size: 13px; line-height: 1.45; color: var(--hc-text); overflow-wrap: anywhere; }

.hc-empty {
  margin: 0; padding: 18px 0; font-size: 13px; color: var(--hc-dim);
  border-top: 1px solid var(--hc-line);
}

.hc-actions { display: flex; gap: 10px; flex-wrap: wrap; padding-top: 18px; }
.hc-btn {
  appearance: none; -webkit-appearance: none;
  flex: 1 1 160px;
  min-height: 56px; padding: 0 18px;
  background: transparent; color: var(--hc-text);
  border: 1px solid #3a3a40; border-radius: 4px;
  font-family: inherit; font-size: 13px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase;
  cursor: pointer; touch-action: manipulation;
}
.hc-btn:hover { border-color: #55555c; }
.hc-btn:active { transform: translateY(1px); }
.hc-btn-primary { background: var(--hc-text); color: #0a0a0b; border-color: var(--hc-text); }
.hc-btn-primary:hover { background: #ffffff; border-color: #ffffff; }
.hc-btn:focus-visible, .hc-toggle:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }

.hc-toast { min-height: 18px; padding-top: 9px; font-size: 11px; color: var(--hc-dim); }

.hc-foot {
  margin-top: 14px; padding-top: 12px;
  border-top: 1px solid var(--hc-line);
  font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
  color: #6a6a70;
}

@media (max-width: 420px) {
  .hc { padding: 14px 12px 16px; }
  .hc-code { font-size: 38px; }
  .hc-elapsed { font-size: 26px; }
  .hc-statvalue { font-size: 22px; }
  .hc-tl { grid-template-columns: 12px 50px 1fr; gap: 7px; }
}
`;
