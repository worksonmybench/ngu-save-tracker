import { scaleBand, scaleLinear } from 'd3-scale';
import { useState } from 'preact/hooks';
import type { DayRow } from '../save/derive';
import { fmtCompact, fmtDay, fmtInt } from './format';
import { AXIS_BAND, HEIGHT, placeTip, useWidth } from './shared';

const TOP = 10;

export function BarChart({ title, days }: { title: string; days: DayRow[] }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<DayRow | null>(null);
  const rows = days.filter((d) => d.expPerDay !== null);
  if (!rows.length) return <div ref={ref} class="chart-empty">Needs saves from at least two days</div>;

  const bottom = HEIGHT - AXIS_BAND;
  const hi = Math.max(...rows.map((d) => d.expPerDay!), 1);
  const y = scaleLinear([0, hi * 1.08], [bottom, TOP]).nice();
  const ticks = y.ticks(4);
  const left = Math.max(...ticks.map((t) => fmtCompact(t).length)) * 7 + 12;
  const x = scaleBand(rows.map((d) => d.day), [left, W - 6]).paddingInner(0.25);
  const every = Math.ceil(rows.length / Math.max(2, Math.floor((W - left) / 64)));
  const bw = Math.min(32, Math.max(1, x.bandwidth() - 2));
  const corner = Math.min(4, bw / 2);

  return (
    <div ref={ref} class="chart">
      <svg width={W} height={HEIGHT} role="img" aria-label={`${title}. Values are in the day-by-day table.`} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line class="grid" x1={left} x2={W - 6} y1={y(t)} y2={y(t)} />
            <text class="tick" x={left - 6} y={y(t)} dy="0.32em" text-anchor="end">{fmtCompact(t)}</text>
          </g>
        ))}
        {rows.map((d, i) => {
          const bx = x(d.day)!;
          const top = y(Math.max(0, d.expPerDay!));
          const r = Math.min(corner, bottom - top);
          return (
            <g key={d.day} onPointerEnter={() => setHover(d)}>
              {/* Hit area is the full column, so short bars are still easy to reach. */}
              <rect x={bx} y={TOP} width={x.bandwidth()} height={bottom - TOP} fill="transparent" />
              <path
                fill="var(--series-1)"
                d={`M${bx},${bottom}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${bottom}Z`}
              />
              {i % every === 0 && <text class="tick" x={bx + bw / 2} y={HEIGHT - 6} text-anchor="middle">{fmtDay(d.time)}</text>}
            </g>
          );
        })}
        <line class="axis" x1={left} x2={W - 6} y1={bottom} y2={bottom} />
      </svg>
      {hover && (
        <div class="tip" style={placeTip(x(hover.day)! + bw / 2, W)}>
          <div class="tip-head">{fmtDay(hover.time)}</div>
          <div class="tip-row"><span>EXP per day</span><b>{fmtInt(hover.expPerDay)}</b></div>
        </div>
      )}
    </div>
  );
}
