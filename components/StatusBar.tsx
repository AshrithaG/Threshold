'use client';

import { useEffect, useState } from 'react';
import type { SceneState } from '@/lib/types';
import { elapsed, fmtClock } from '@/lib/scene';

export interface StatusBarProps {
  state: SceneState | null;
  selfId: string;
  rtStatus: 'connecting' | 'live' | 'offline';
  planModel: string | null;
  degraded: boolean;
}

function safeElapsed(state: SceneState | null, now: number): number {
  if (!state) return 0;
  try {
    const v = elapsed(state, now);
    if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
  } catch {
    /* fall through to the local derivation */
  }
  const created = typeof state.createdAt === 'number' ? state.createdAt : now;
  return Math.max(0, now - created);
}

function safeClock(ms: number): string {
  try {
    const s = fmtClock(ms);
    if (typeof s === 'string' && s.length > 0) return s;
  } catch {
    /* fall through to the local formatter */
  }
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Model ids are long. Keep the tail, which is the part that identifies the build. */
function shortModel(model: string | null): string {
  if (!model) return 'NO PLAN YET';
  const m = model.trim();
  if (m.length <= 24) return m;
  return `${m.slice(0, 10)}…${m.slice(-12)}`;
}

export default function StatusBar({
  state,
  selfId,
  rtStatus,
  planModel,
  degraded,
}: StatusBarProps) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const participants = state && Array.isArray(state.participants) ? state.participants : [];
  const liveCount = participants.filter((p) => p && p.status !== 'left').length;
  const leftCount = participants.filter((p) => p && p.status === 'left').length;
  const strugglingCount = participants.filter((p) => p && p.status === 'struggling').length;
  const self = participants.find((p) => p && p.id === selfId) || null;

  const offline = !state || state.online === false || rtStatus === 'offline';
  const clock = safeClock(safeElapsed(state, now));

  const statusWord = offline ? 'OFFLINE' : rtStatus === 'live' ? 'LIVE' : 'CONNECTING';
  const dotClass = offline ? 'dot off' : rtStatus === 'live' ? 'dot live' : 'dot pending';

  return (
    <div className="bar" role="status" aria-live="polite">
      <div className="grp code-grp">
        <span className="lbl">SCENE</span>
        <span className="code">{state?.code || '----'}</span>
      </div>

      <div className="grp clock-grp">
        <span className="lbl">ELAPSED</span>
        <span className="clock">{clock}</span>
      </div>

      <div className="grp">
        <span className="lbl">ON SCENE</span>
        <span className="count">{liveCount}</span>
        {strugglingCount > 0 && <span className="mini warn">{strugglingCount} STRUGGLING</span>}
        {leftCount > 0 && <span className="mini">{leftCount} LEFT</span>}
      </div>

      <div className="grp">
        <span className={dotClass} aria-hidden="true" />
        <span className="stat">{statusWord}</span>
      </div>

      <div className="grp model-grp" title={planModel || 'no plan produced yet'}>
        <span className="lbl">PLAN BY</span>
        <span className="model">{shortModel(planModel)}</span>
        {degraded && <span className="mini warn">DEGRADED</span>}
      </div>

      {self && (
        <div className="grp you-grp">
          <span className="lbl">YOU</span>
          <span className="you">{self.name}</span>
        </div>
      )}

      {offline && <span className="chip-off">OFFLINE</span>}

      <style jsx>{`
        .bar {
          position: sticky;
          top: 0;
          z-index: 40;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px 18px;
          padding: 10px 14px;
          background: #0d0d0f;
          border-bottom: 1px solid #232327;
          color: #f5f5f7;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .grp {
          display: flex;
          align-items: baseline;
          gap: 7px;
          min-width: 0;
        }
        .lbl {
          font-size: 10px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #6e6e76;
          white-space: nowrap;
        }
        .code {
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 20px;
          font-weight: 600;
          letter-spacing: 0.22em;
          color: #f5f5f7;
        }
        .clock-grp {
          align-items: baseline;
        }
        .clock {
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 26px;
          font-weight: 600;
          line-height: 1;
          letter-spacing: 0.04em;
          font-variant-numeric: tabular-nums;
          color: #ffffff;
        }
        .count {
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 18px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .mini {
          font-size: 10px;
          letter-spacing: 0.1em;
          color: #8e8e93;
          border: 1px solid #2c2c30;
          padding: 2px 5px;
          border-radius: 3px;
          white-space: nowrap;
        }
        .mini.warn {
          color: #ff9f0a;
          border-color: #4a3410;
        }
        .stat {
          font-size: 12px;
          letter-spacing: 0.14em;
          font-weight: 600;
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          display: inline-block;
          flex: none;
          align-self: center;
        }
        .dot.live {
          background: #30d158;
          box-shadow: 0 0 0 0 rgba(48, 209, 88, 0.55);
          animation: ping 2.2s ease-out infinite;
        }
        .dot.pending {
          background: #ff9f0a;
        }
        .dot.off {
          background: #ff3b30;
        }
        .model-grp {
          min-width: 0;
        }
        .model {
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 12px;
          color: #c7c7cc;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 42vw;
        }
        .you {
          font-size: 13px;
          font-weight: 600;
          color: #c7c7cc;
        }
        .chip-off {
          margin-left: auto;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.16em;
          color: #fff;
          background: #ff3b30;
          padding: 4px 9px;
          border-radius: 3px;
        }
        @keyframes ping {
          0% {
            box-shadow: 0 0 0 0 rgba(48, 209, 88, 0.5);
          }
          70% {
            box-shadow: 0 0 0 7px rgba(48, 209, 88, 0);
          }
          100% {
            box-shadow: 0 0 0 0 rgba(48, 209, 88, 0);
          }
        }
        @media (max-width: 520px) {
          .bar {
            gap: 4px 14px;
            padding: 8px 11px;
          }
          .clock {
            font-size: 22px;
          }
          .code {
            font-size: 17px;
          }
          .you-grp {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .dot.live {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
