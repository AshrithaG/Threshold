'use client';

import { useEffect, useRef, useState } from 'react';
import type { Assignment, Participant, RoleId, SceneState } from '@/lib/types';
import { ROLE_COLOR, ROLE_LABEL } from '@/lib/types';

export interface ResponderCardProps {
  participant: Participant | null;
  assignment: Assignment | null;
  state: SceneState | null;
  /** instant, device-local bpm from the camera — falls back to state.compressionRate */
  liveRate?: number | null;
  /** fires the "swap me out" beat; when absent the button is hidden */
  onSwapOut?: () => void;
}

/** Used only when no plan has reached this device yet. Operational, never clinical. */
const FALLBACK_INSTRUCTION: Record<RoleId, string> = {
  compressions:
    'Heel of your hand on the centre of the chest. Push hard, push fast, and stay on the beat.',
  swap_ready:
    'Kneel opposite the person doing compressions. Take over the moment the commander calls the swap.',
  aed: 'Go now. Bring the AED back to this spot and say "AED" out loud when you return.',
  call911: 'Put the dispatcher on speaker. Give the address first, then say cardiac arrest, CPR in progress.',
  door: 'Get to the street entrance. Hold the door, wave the medics down, and walk them straight here.',
  crowd: 'Clear a two metre circle. Move bags and chairs, keep the path to the door open.',
  unassigned: 'The commander is placing you. Stay close and keep your hands free.',
};

function rateVerdict(bpm: number | null): { word: string; tone: 'low' | 'good' | 'high' | 'none' } {
  if (bpm === null || !isFinite(bpm)) return { word: 'NO RATE', tone: 'none' };
  if (bpm < 100) return { word: 'TOO SLOW', tone: 'low' };
  if (bpm > 120) return { word: 'TOO FAST', tone: 'high' };
  return { word: 'IN RANGE', tone: 'good' };
}

export default function ResponderCard({
  participant,
  assignment,
  state,
  liveRate,
  onSwapOut,
}: ResponderCardProps) {
  const role: RoleId = (assignment?.role || participant?.role || 'unassigned') as RoleId;
  const color = ROLE_COLOR[role] || ROLE_COLOR.unassigned;
  const label = ROLE_LABEL[role] || ROLE_LABEL.unassigned;
  const instruction =
    (assignment?.instruction && assignment.instruction.trim()) || FALLBACK_INSTRUCTION[role];

  const struggling = participant?.status === 'struggling';
  const stateRate =
    state && typeof state.compressionRate === 'number' && isFinite(state.compressionRate)
      ? Math.round(state.compressionRate)
      : null;
  const bpm =
    typeof liveRate === 'number' && isFinite(liveRate) ? Math.round(liveRate) : stateRate;
  const verdict = rateVerdict(bpm);

  // A fresh role should announce itself visually as well as out loud.
  const [justChanged, setJustChanged] = useState(false);
  const prevRole = useRef<RoleId | null>(null);
  useEffect(() => {
    if (prevRole.current !== null && prevRole.current !== role) {
      setJustChanged(true);
      const t = setTimeout(() => setJustChanged(false), 2200);
      prevRole.current = role;
      return () => clearTimeout(t);
    }
    prevRole.current = role;
    return undefined;
  }, [role]);

  // Pace the pulse to the measured rate so the card breathes with the compressions.
  const pulseSeconds = bpm && bpm >= 60 && bpm <= 180 ? 60 / bpm : 0.545;

  return (
    <section
      className={`rc${role === 'compressions' ? ' pulsing' : ''}${justChanged ? ' changed' : ''}`}
      style={
        {
          ['--role' as any]: color,
          ['--pulse' as any]: `${pulseSeconds.toFixed(3)}s`,
        } as React.CSSProperties
      }
      aria-label={`Your role: ${label}`}
    >
      <div className="accent" aria-hidden="true" />

      <header className="head">
        <span className="eyebrow">YOUR JOB</span>
        <span className="who">
          {participant?.name || 'THIS PHONE'}
          {participant?.trained ? <span className="trained">SAYS TRAINED</span> : null}
        </span>
      </header>

      <h1 className="big">{label}</h1>

      {role === 'unassigned' ? (
        <p className="instr standby">The commander is placing you. Do not start anything yet.</p>
      ) : (
        <p className="instr">{instruction}</p>
      )}

      {role === 'compressions' && (
        <div className={`rate tone-${verdict.tone}`}>
          <div className="rate-main">
            <span className="rate-num">{bpm === null ? '—' : bpm}</span>
            <span className="rate-unit">BPM</span>
          </div>
          <div className="rate-side">
            <span className="rate-word">{verdict.word}</span>
            <span className="rate-target">TARGET 100–120</span>
          </div>
        </div>
      )}

      {assignment?.urgency === 'now' && role !== 'unassigned' && (
        <div className="urgent">DO THIS NOW</div>
      )}

      {struggling && (
        <div className="flag">SWAP REQUESTED — THE COMMANDER HAS BEEN TOLD</div>
      )}

      {onSwapOut && participant && role !== 'unassigned' && (
        <button
          type="button"
          className="swap"
          onClick={onSwapOut}
          disabled={struggling}
        >
          {struggling ? 'SWAP REQUESTED' : "I CAN'T DO THIS — SWAP ME OUT"}
        </button>
      )}

      <style jsx>{`
        .rc {
          position: relative;
          overflow: hidden;
          background: #121215;
          border: 1px solid #232327;
          border-radius: 4px;
          padding: 20px 18px 18px 26px;
          color: #f5f5f7;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .rc::before {
          content: '';
          position: absolute;
          inset: 0;
          background: radial-gradient(120% 90% at 0% 0%, var(--role) 0%, transparent 62%);
          opacity: 0.16;
          pointer-events: none;
        }
        .accent {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 8px;
          background: var(--role);
        }
        .rc.pulsing .accent {
          animation: beat var(--pulse) ease-in-out infinite;
        }
        .rc.changed {
          animation: swell 2.2s ease-out 1;
        }
        .head {
          position: relative;
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .eyebrow {
          font-size: 11px;
          letter-spacing: 0.2em;
          color: #8e8e93;
          font-weight: 600;
        }
        .who {
          font-size: 13px;
          color: #c7c7cc;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .trained {
          font-size: 9px;
          letter-spacing: 0.12em;
          border: 1px solid #2c2c30;
          color: #8e8e93;
          padding: 2px 5px;
          border-radius: 3px;
        }
        .big {
          position: relative;
          margin: 12px 0 0;
          font-size: clamp(38px, 11.5vw, 62px);
          line-height: 0.94;
          font-weight: 800;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: var(--role);
        }
        .instr {
          position: relative;
          margin: 14px 0 0;
          font-size: 20px;
          line-height: 1.34;
          color: #e8e8ed;
          max-width: 44ch;
        }
        .instr.standby {
          color: #a1a1a8;
        }
        .rate {
          position: relative;
          margin-top: 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          border: 1px solid #2c2c30;
          border-radius: 4px;
          padding: 12px 14px;
          background: #0e0e11;
        }
        .rate-main {
          display: flex;
          align-items: baseline;
          gap: 8px;
        }
        .rate-num {
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 52px;
          font-weight: 700;
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        .rate-unit {
          font-size: 13px;
          letter-spacing: 0.16em;
          color: #8e8e93;
        }
        .rate-side {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }
        .rate-word {
          font-size: 15px;
          font-weight: 700;
          letter-spacing: 0.12em;
        }
        .rate-target {
          font-size: 10px;
          letter-spacing: 0.14em;
          color: #6e6e76;
        }
        .tone-good .rate-num,
        .tone-good .rate-word {
          color: #30d158;
        }
        .tone-low .rate-num,
        .tone-low .rate-word {
          color: #ff9f0a;
        }
        .tone-high .rate-num,
        .tone-high .rate-word {
          color: #ff9f0a;
        }
        .tone-none .rate-num,
        .tone-none .rate-word {
          color: #6e6e76;
        }
        .urgent {
          position: relative;
          margin-top: 14px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.2em;
          color: #0a0a0b;
          background: var(--role);
          display: inline-block;
          padding: 6px 10px;
          border-radius: 3px;
        }
        .flag {
          position: relative;
          margin-top: 14px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: #ff9f0a;
          border: 1px solid #4a3410;
          background: #1b1408;
          padding: 10px 12px;
          border-radius: 3px;
        }
        .swap {
          position: relative;
          margin-top: 18px;
          width: 100%;
          min-height: 64px;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: #f5f5f7;
          background: #1c1c20;
          border: 1px solid #3a3a40;
          border-radius: 4px;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        .swap:active {
          background: #2a2a30;
        }
        .swap:disabled {
          opacity: 0.45;
          cursor: default;
        }
        @keyframes beat {
          0%,
          100% {
            opacity: 0.55;
            transform: scaleX(1);
          }
          18% {
            opacity: 1;
            transform: scaleX(2.1);
          }
        }
        @keyframes swell {
          0% {
            box-shadow: inset 0 0 0 3px var(--role);
          }
          100% {
            box-shadow: inset 0 0 0 0 transparent;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .rc.pulsing .accent,
          .rc.changed {
            animation: none;
          }
        }
      `}</style>
    </section>
  );
}
