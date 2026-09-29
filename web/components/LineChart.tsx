'use client';
// Jednoduchý SVG spojnicový graf: 2px čáry, hairline mřížka, crosshair + tooltip se všemi sériemi.
import { useEffect, useMemo, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string;
  points: { x: number; y: number }[];
  /** schodovitá křivka (Kaplan–Meier) */
  step?: boolean;
}

interface Props {
  series: Series[];
  height?: number;
  xFormat?: (x: number) => string;
  yFormat?: (y: number) => string;
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
  /** vodorovná referenční čára (např. práh marže) */
  refY?: { y: number; label: string };
  /** svislá referenční čára (např. potřebná doba) */
  refX?: { x: number; label: string };
  ariaLabel: string;
}

const PAD = { l: 48, r: 72, t: 12, b: 26 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function LineChart({ series, height = 220, xFormat = String, yFormat = String, yMin, yMax, xMin, xMax, refY, refX, ariaLabel }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [series.some((s) => s.points.length > 0)]);

  const all = series.flatMap((s) => s.points);
  const x0 = xMin ?? Math.min(...all.map((p) => p.x));
  const x1 = xMax ?? Math.max(...all.map((p) => p.x));
  const ys = all.map((p) => p.y);
  let y0 = yMin ?? Math.min(...ys, refY?.y ?? Infinity);
  let y1 = yMax ?? Math.max(...ys, refY?.y ?? -Infinity);
  if (y0 === y1) (y0 -= 1), (y1 += 1);
  const iw = Math.max(10, w - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + (x1 > x0 ? ((x - x0) / (x1 - x0)) * iw : iw / 2);
  const sy = (y: number) => PAD.t + ih - ((y - y0) / (y1 - y0)) * ih;

  const paths = useMemo(
    () =>
      series.map((s) => {
        const pts = [...s.points].sort((a, b) => a.x - b.x);
        let d = '';
        pts.forEach((p, i) => {
          if (i === 0) d += `M${sx(p.x)},${sy(p.y)}`;
          else if (s.step) d += `H${sx(p.x)}V${sy(p.y)}`;
          else d += `L${sx(p.x)},${sy(p.y)}`;
        });
        if (s.step && pts.length) d += `H${sx(x1)}`;
        return { s, d, last: pts[pts.length - 1] };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, w, height, x0, x1, y0, y1],
  );

  if (!all.length) return <div className="flex h-24 items-center justify-center text-muted">Zatím bez dat</div>;

  const valueAt = (s: Series, x: number): number | null => {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    let v: number | null = null;
    for (const p of pts) {
      if (p.x <= x) v = p.y;
      else break;
    }
    return v;
  };

  // koncové popisky jen když se nepřekrývají (jinak nese identitu legenda + tooltip)
  const endYs = paths.filter((p) => p.last).map((p) => sy(p.last!.y)).sort((a, b) => a - b);
  const labelsFit = series.length <= 4 && endYs.every((y, i) => i === 0 || y - endYs[i - 1] >= 13);
  const yt = niceTicks(y0, y1);
  const xt = niceTicks(x0, x1, 5);

  return (
    <div className="relative">
      <svg
        ref={ref}
        width="100%"
        height={height}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(e) => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          const px = e.clientX - r.left;
          const x = x0 + ((px - PAD.l) / iw) * (x1 - x0);
          setHover(Math.min(x1, Math.max(x0, x)));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {yt.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.l} x2={PAD.l + iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 6} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="num">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {xt.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={height - 8} textAnchor="middle" fontSize={11} fill="var(--muted)" className="num">
            {xFormat(t)}
          </text>
        ))}
        <line x1={PAD.l} x2={PAD.l + iw} y1={PAD.t + ih} y2={PAD.t + ih} stroke="var(--axis)" strokeWidth={1} />
        {refY && (
          <g>
            <line x1={PAD.l} x2={PAD.l + iw} y1={sy(refY.y)} y2={sy(refY.y)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="0" opacity={0.7} />
            <text x={PAD.l + iw + 4} y={sy(refY.y)} dy="0.32em" fontSize={11} fill="var(--muted)">
              {refY.label}
            </text>
          </g>
        )}
        {refX && refX.x >= x0 && refX.x <= x1 && (
          <g>
            <line x1={sx(refX.x)} x2={sx(refX.x)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--muted)" strokeWidth={1} opacity={0.7} />
            <text x={sx(refX.x) + 4} y={PAD.t + 10} fontSize={11} fill="var(--muted)">
              {refX.label}
            </text>
          </g>
        )}
        {paths.map(({ s, d, last }) => (
          <g key={s.key}>
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {last && (
              <>
                <circle cx={s.step ? sx(x1) : sx(last.x)} cy={sy(last.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                {labelsFit && (
                  <text x={(s.step ? sx(x1) : sx(last.x)) + 8} y={sy(last.y)} dy="0.32em" fontSize={11} fill="var(--ink-2)">
                    {s.label}
                  </text>
                )}
              </>
            )}
          </g>
        ))}
        {hover !== null && <line x1={sx(hover)} x2={sx(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--axis)" strokeWidth={1} />}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs shadow"
          style={{ left: Math.min(w - 170, Math.max(0, sx(hover) + 10)) }}
        >
          <div className="mb-1 text-muted num">{xFormat(hover)}</div>
          {series.map((s) => {
            const v = valueAt(s, hover);
            return (
              <div key={s.key} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3" style={{ background: s.color }} aria-hidden />
                <span className="num font-semibold text-ink">{v === null ? '–' : yFormat(v)}</span>
                <span className="text-ink-2">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink-2">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: s.color }} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
