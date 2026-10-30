import { bisector } from 'd3-array';
import { scaleLinear, scaleLog, scaleTime } from 'd3-scale';
import { line } from 'd3-shape';
import { useState } from 'preact/hooks';
import type { Row } from '../save/derive';
import { fmtDateTime, fmtDay } from './format';
import { Legend, placeTip, useWidth, HEIGHT, AXIS_BAND } from './shared';

export type Series = { key: keyof Row; label: string; slot: number };

type Props = {
  title: string;
  rows: Row[];
  series: Series[];
  fmt: (v: number) => string;
  log?: boolean;
  fromMin?: boolean;
  bands?: boolean;
  markGearSwaps?: boolean;
};

const TOP = 10;
const MIN_TICK_SPACING = 56;
const bisect = bisector((r: Row) => r.savedAt).center;

export function LineChart({ title, rows, series, fmt, log, fromMin, bands, markGearSwaps }: Props) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const val = (r: Row, s: Series) => {
    const v = r[s.key];
    return typeof v === 'number' && Number.isFinite(v) && (!log || v > 0) ? v : null;
  };
  const values = rows.flatMap((r) => series.map((s) => val(r, s)).filter((v): v is number => v !== null));
  if (!values.length) {
    return <div ref={ref} class="chart-empty">No data for this range</div>;
  }

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const bottom = HEIGHT - AXIS_BAND;
  const y = log
    ? scaleLog([lo * 0.8, hi * 1.25], [bottom, TOP])
    : scaleLinear([fromMin ? lo - (hi - lo) * 0.05 - (hi === lo ? 1 : 0) : 0, hi === 0 ? 1 : hi * 1.08], [bottom, TOP]).nice();
  let ticks = y.ticks(4) as number[];
  if (log) {
    const decades = ticks.filter((d) => Math.abs(Math.log10(d) - Math.round(Math.log10(d))) < 1e-9);
    ticks = decades.length >= 2 ? decades : (scaleLinear(y.domain(), [0, 1]).nice().ticks(3) as number[]).filter((d) => d > 0);
  }
  const left = Math.max(...ticks.map((t) => fmt(t).length)) * 7 + 12;
  const right = series.length > 1 ? 76 : 12;

  const first = rows[0].savedAt;
  const last = rows[rows.length - 1].savedAt;
  const x = scaleTime(first === last ? [first - 864e5, last + 864e5] : [first, last], [left, W - right]);
  // d3 snaps to round intervals, so a low count can yield a single month tick.
  const maxTicks = Math.max(2, Math.floor((W - left - right) / 60));
  let xTicks = x.ticks(Math.max(2, Math.floor((W - left - right) / 90)));
  for (let n = xTicks.length + 1; xTicks.length < 3 && n <= maxTicks; n++) xTicks = x.ticks(n);
  // Short ranges tick more often than daily, and labels only show the day.
  xTicks = xTicks.filter((t, i) => i === 0 || fmtDay(+t) !== fmtDay(+xTicks[i - 1]));
  // Raising the count can overshoot to a denser interval, so thin back to what fits.
  const tickStep = Math.ceil((xTicks.length * MIN_TICK_SPACING) / (W - left - right));
  xTicks = xTicks.filter((_, i) => i % tickStep === 0);

  // Alternate grey per run; challenges tinted, since they contain many short rebirths.
  const runStarts = bands ? rows.filter((r, i) => i === 0 || r.runId !== rows[i - 1].runId) : [];

  // Direct end labels, nudged apart when two series finish close together.
  const ends = series
    .map((s) => {
      const pts = rows.filter((r) => val(r, s) !== null);
      const p = pts[pts.length - 1];
      return p && { s, t: p.savedAt, py: y(val(p, s)!) };
    })
    .filter((e): e is NonNullable<typeof e> => !!e)
    .sort((a, b) => a.py - b.py);
  let prevY = -Infinity;
  const endLabels = ends.map((e) => {
    const ly = Math.max(e.py, prevY + 14);
    prevY = ly;
    return { ...e, ly };
  });

  const current = hover === null ? null : rows[hover];
  const move = (ev: PointerEvent) => {
    const svg = ev.currentTarget as SVGSVGElement;
    setHover(bisect(rows, x.invert(ev.clientX - svg.getBoundingClientRect().left).getTime()));
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const step = ev.key === 'ArrowLeft' ? -1 : 1;
      setHover(Math.min(rows.length - 1, Math.max(0, (hover ?? (step < 0 ? rows.length : -1)) + step)));
    } else if (ev.key === 'Escape') setHover(null);
  };

  return (
    <div>
      {series.length > 1 && <Legend items={series} />}
      <div ref={ref} class="chart">
        <svg
          width={W}
          height={HEIGHT}
          role="img"
          tabIndex={0}
          aria-label={`${title}. Use left and right arrow keys to read values.`}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={key}
        >
          {runStarts.map((r, i) => {
            if (!r.inChallenge && i % 2) return null;
            const x0 = x(r.savedAt);
            const x1 = i + 1 < runStarts.length ? x(runStarts[i + 1].savedAt) : W - right;
            return <rect key={r.id} class={r.inChallenge ? 'band-challenge' : 'band-run'} x={x0} y={TOP} width={Math.max(1, x1 - x0)} height={bottom - TOP} />;
          })}
          {ticks.map((t) => (
            <g key={t}>
              <line class="grid" x1={left} x2={W - right} y1={y(t)} y2={y(t)} />
              <text class="tick" x={left - 6} y={y(t)} dy="0.32em" text-anchor="end">{fmt(t)}</text>
            </g>
          ))}
          <line class="axis" x1={left} x2={W - right} y1={bottom} y2={bottom} />
          {xTicks.map((t) => (
            <text key={+t} class="tick" x={x(t)} y={HEIGHT - 6} text-anchor={x(t) > W - 24 ? 'end' : 'middle'}>{fmtDay(+t)}</text>
          ))}
          {series.map((s) => {
            const pts = rows.filter((r) => val(r, s) !== null);
            const d = line<Row>().x((r) => x(r.savedAt)).y((r) => y(val(r, s)!))(pts);
            return <path key={String(s.key)} d={d ?? ''} fill="none" stroke={`var(--series-${s.slot})`} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />;
          })}
          {endLabels.map((e) => (
            <g key={String(e.s.key)}>
              <circle cx={x(e.t)} cy={e.py} r="4" fill={`var(--series-${e.s.slot})`} stroke="var(--surface)" stroke-width="2" />
              {series.length > 1 && <text class="end-label" x={x(e.t) + 8} y={e.ly} dy="0.32em">{e.s.label}</text>}
            </g>
          ))}
          {current && (
            <g>
              <line class="crosshair" x1={x(current.savedAt)} x2={x(current.savedAt)} y1={TOP} y2={bottom} />
              {series.map((s) => {
                const v = val(current, s);
                return v === null ? null : <circle key={String(s.key)} cx={x(current.savedAt)} cy={y(v)} r="4" fill={`var(--series-${s.slot})`} stroke="var(--surface)" stroke-width="2" />;
              })}
            </g>
          )}
        </svg>
        {current && (
          <div class="tip" style={placeTip(x(current.savedAt), W)}>
            <div class="tip-head">{fmtDateTime(current.savedAt)}</div>
            {series.map((s) => {
              const v = val(current, s);
              return (
                v !== null && (
                  <div key={String(s.key)} class="tip-row">
                    {series.length > 1 && <span class="swatch" style={{ background: `var(--series-${s.slot})` }} />}
                    <span>{s.label}</span>
                    <b>{fmt(v)}</b>
                  </div>
                )
              );
            })}
            {current.inChallenge && <div class="tip-note">In {current.inChallenge} challenge</div>}
            {markGearSwaps && hover! > 0 && current.loadout !== rows[hover! - 1].loadout && <div class="tip-note">Gear changed since the previous save</div>}
          </div>
        )}
      </div>
    </div>
  );
}
