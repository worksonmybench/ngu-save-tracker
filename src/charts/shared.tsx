import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export const HEIGHT = 244;
export const AXIS_BAND = 24;

export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref.current]);
  return [ref, width] as const;
}

// Keeps the tooltip inside the chart by flipping it past the crosshair near the right edge.
export function placeTip(px: number, width: number) {
  return px > width * 0.6 ? { right: `${width - px + 12}px` } : { left: `${px + 12}px` };
}

export function Legend({ items }: { items: { label: string; slot: number }[] }) {
  return (
    <div class="legend">
      {items.map((s) => (
        <span key={s.label}>
          <span class="swatch" style={{ background: `var(--series-${s.slot})` }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
