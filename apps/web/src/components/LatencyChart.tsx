/**
 * Provider latency over time. One y-axis (ms), one 2px line per provider.
 * Color follows the PROVIDER (its configured order), never its rank; palette validated with the
 * dataviz validator for the dark surface (worst adjacent CVD ΔE 8.4 → legend + direct labels kept).
 * Down samples are gaps, not zeros. Hover: crosshair + tooltip. A table view is always available.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryResponse } from "../api";

export const SERIES = ["var(--color-series-1)", "var(--color-series-2)", "var(--color-series-3)", "var(--color-series-4)"];

interface Point {
  t: number;
  v: number | null;
}

export function LatencyChart({ samples, providers }: { samples: HistoryResponse["samples"]; providers: string[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver((e) => setWidth(Math.max(320, e[0]!.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [wrap.current]);

  const shown = providers.slice(0, 4); // palette is validated for 4 adjacent series
  const series = useMemo(() => {
    const m = new Map<string, Point[]>(shown.map((p) => [p, []]));
    for (const s of samples) m.get(s.provider)?.push({ t: new Date(s.at).getTime(), v: s.reachable ? s.latencyMs : null });
    return m;
  }, [samples, shown.join(",")]);

  const times = [...new Set(samples.map((s) => new Date(s.at).getTime()))].sort((a, b) => a - b);
  if (times.length < 2)
    return (
      <div ref={wrap}>
        <p className="py-6 text-sm text-muted">Not enough samples yet — the prober records one every 30 s.</p>
      </div>
    );

  const H = 240;
  const M = { l: 56, r: 128, t: 12, b: 28 };
  const w = width - M.l - M.r;
  const h = H - M.t - M.b;
  const t0 = times[0]!;
  const t1 = times.at(-1)!;
  const maxV = Math.max(1, ...samples.filter((s) => s.reachable).map((s) => s.latencyMs));
  const yMax = niceCeil(maxV);
  const x = (t: number) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v: number) => M.t + h - (v / yMax) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * yMax));

  const path = (pts: Point[]) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (p.v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  // End-label layout: sort by y, enforce a 14px minimum gap, then shift up if the stack overflows the plot.
  const GAP = 14;
  const endLabels = shown
    .map((p, i) => {
      const last = (series.get(p) ?? []).filter((q) => q.v !== null).at(-1);
      return last ? { p, i, cx: x(last.t), cy: y(last.v!), ly: y(last.v!) } : null;
    })
    .filter((l): l is { p: string; i: number; cx: number; cy: number; ly: number } => l !== null)
    .sort((a, b) => a.cy - b.cy);
  for (let k = 1; k < endLabels.length; k++) endLabels[k]!.ly = Math.max(endLabels[k]!.ly, endLabels[k - 1]!.ly + GAP);
  const overflow = (endLabels.at(-1)?.ly ?? 0) - (M.t + h);
  if (overflow > 0) for (const l of endLabels) l.ly -= overflow;
  for (let k = endLabels.length - 2; k >= 0; k--) endLabels[k]!.ly = Math.min(endLabels[k]!.ly, endLabels[k + 1]!.ly - GAP);

  const nearest = hoverT === null ? null : times.reduce((a, b) => (Math.abs(b - hoverT) < Math.abs(a - hoverT) ? b : a));
  const valueAt = (p: string, t: number) => series.get(p)?.find((pt) => pt.t === t)?.v;

  return (
    <div ref={wrap}>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-2" aria-label="Legend">
        <span className="text-muted">Latency (ms)</span>
        {shown.map((p, i) => (
          <span key={p} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES[i] }} />
            {p}
          </span>
        ))}
        <button type="button" className="ml-auto text-link underline underline-offset-2 hover:no-underline" onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {showTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-surface text-muted">
              <tr>
                <th className="py-1 text-left font-normal">Time</th>
                {shown.map((p) => (
                  <th key={p} className="py-1 text-right font-normal">
                    {p} (ms)
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...times].reverse().map((t) => (
                <tr key={t} className="border-t border-line">
                  <td className="py-1 text-ink-2">{new Date(t).toLocaleTimeString()}</td>
                  {shown.map((p) => {
                    const v = valueAt(p, t);
                    return (
                      <td key={p} className="py-1 text-right text-ink">
                        {v === undefined ? "—" : v === null ? "down" : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={`Latency over time for ${shown.join(", ")}`}
            onMouseMove={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const px = e.clientX - r.left;
              if (px < M.l || px > M.l + w) return setHoverT(null);
              setHoverT(t0 + ((px - M.l) / w) * (t1 - t0));
            }}
            onMouseLeave={() => setHoverT(null)}
          >
            {ticks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={M.l + w} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--color-axis)" : "var(--color-line)"} strokeWidth={1} />
                <text x={M.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)" className="tabular">
                  {v.toLocaleString()}
                </text>
              </g>
            ))}
            {/* Narrow charts (phones) get only the first and last time, so labels never run together. */}
            {(w < 300 ? [t0, t1] : [t0, (t0 + t1) / 2, t1]).map((t, i, all) => (
              <text key={i} x={x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === all.length - 1 ? "end" : "middle"} fontSize={11} fill="var(--color-muted)">
                {new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </text>
            ))}
            {shown.map((p, i) => (
              <path key={p} d={path(series.get(p) ?? [])} fill="none" stroke={SERIES[i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* direct end labels (secondary encoding), text in ink — not series color; laid out without overlap */}
            {endLabels.map((l) => (
              <g key={l.p}>
                <circle cx={l.cx} cy={l.cy} r={4} fill={SERIES[l.i]} stroke="var(--color-surface)" strokeWidth={2} />
                {Math.abs(l.ly - l.cy) > 2 && <line x1={l.cx + 5} y1={l.cy} x2={M.l + w + 6} y2={l.ly} stroke="var(--color-axis)" strokeWidth={1} />}
                <text x={M.l + w + 8} y={l.ly + 4} fontSize={11} fill="var(--color-ink-2)">
                  {l.p}
                </text>
              </g>
            ))}
            {nearest !== null && (
              <g>
                <line x1={x(nearest)} x2={x(nearest)} y1={M.t} y2={M.t + h} stroke="var(--color-muted)" strokeDasharray="3 3" />
                {shown.map((p, i) => {
                  const v = valueAt(p, nearest);
                  return v ? <circle key={p} cx={x(nearest)} cy={y(v)} r={4} fill={SERIES[i]} stroke="var(--color-surface)" strokeWidth={2} /> : null;
                })}
              </g>
            )}
          </svg>
          {nearest !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-lg border border-line-strong bg-surface-3/95 px-3 py-2 text-xs shadow-lg"
              style={{ left: Math.min(x(nearest) + 12, width - 190) }}
            >
              <p className="mb-1 text-muted">{new Date(nearest).toLocaleTimeString()}</p>
              {shown.map((p, i) => {
                const v = valueAt(p, nearest);
                return (
                  <p key={p} className="flex items-center gap-2 text-ink">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: SERIES[i] }} />
                    <span className="text-ink-2">{p}</span>
                    <span className="ml-auto tabular">{v === undefined ? "—" : v === null ? "down" : `${v} ms`}</span>
                  </p>
                );
              })}
            </div>
          )}
        </div>
      )}
      {providers.length > 4 && <p className="mt-1 text-xs text-muted">Showing the first 4 configured providers; see the Health table above for the rest.</p>}
    </div>
  );
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
