const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const SUFFIX: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

export const fmtInt = (v: number | null | undefined) => (v == null ? '—' : int.format(v));
export const fmtDec = (v: number | null | undefined) => (v == null ? '—' : dec.format(v));
export const fmtPow10 = (v: number | null | undefined) => (v == null ? '—' : `10^${v.toFixed(1)}`);

// Stats span dozens of orders of magnitude, so past trillions switch to scientific.
export function fmtCompact(v: number | null | undefined) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e15) return v.toExponential(2).replace('e+', 'e');
  for (const [size, s] of SUFFIX) if (abs >= size) return `${dec.format(v / size)}${s}`;
  return abs < 100 ? dec.format(v) : int.format(v);
}

export const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const fmtDateTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
