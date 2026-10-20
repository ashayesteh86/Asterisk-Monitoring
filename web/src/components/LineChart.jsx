// Time-series line chart (SVG) with optional area fill, crosshair and tooltip. RTL: oldest on the right.
import { useEffect, useRef, useState } from "react";
import { fa, faNum } from "../jalali.js";

export default function LineChart({ points, series, height = 240, xLabel, tooltipTitle, format = faNum, yMax }) {
  const box = useRef(null);
  const [W, setW] = useState(800);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = height, padL = 10, padR = 40, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(yMax || 0, 1, ...points.flatMap((p) => series.map((s) => Number(p[s.key]) || 0)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const t0 = points[0]?.t ?? 0, t1 = points[points.length - 1]?.t ?? 1;
  const x = (t) => W - padR - ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v) => padT + ih - (v / top) * ih;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const nTicks = Math.max(2, Math.min(7, Math.floor(W / 110)));
  const xTicks = points.length > 1 ? Array.from({ length: nTicks }, (_, i) => t0 + ((t1 - t0) * i) / (nTicks - 1)) : [];

  const onMove = (e) => {
    if (points.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((W - padR - px) / iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div ref={box} className="relative">
      {points.length < 2 ? (
        <div className="flex items-center justify-center text-sm text-ink-3" style={{ height }}>هنوز داده کافی جمع‌آوری نشده — هر ۱۰ ثانیه یک نمونه ثبت می‌شود</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height, direction: "ltr" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              <text x={W - padR + 6} y={y(t) + 4} fontSize="11" fill="var(--ink-3)">{faNum(t)}</text>
            </g>
          ))}
          {xTicks.map((t, i) => <text key={i} x={x(t)} y={H - 7} fontSize="11" fill="var(--ink-3)" textAnchor={i === 0 ? "end" : i === xTicks.length - 1 ? "start" : "middle"}>{xLabel(t)}</text>)}
          {series.map((s) => {
            const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(Number(p[s.key]) || 0).toFixed(1)}`).join("");
            return (
              <g key={s.key}>
                {s.area && <path d={`${d}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`} fill={s.color} opacity="0.14" />}
                <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="var(--ink-3)" />
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={padT} y2={padT + ih} stroke="var(--ink-3)" strokeDasharray="3 3" />
              {series.map((s) => <circle key={s.key} cx={x(hp.t)} cy={y(Number(hp[s.key]) || 0)} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />)}
            </g>
          )}
        </svg>
      )}
      {hp && (
        <div className="card pointer-events-none absolute top-1 z-10 min-w-40 px-3 py-2 text-xs shadow-lg" style={{ right: Math.min(W - 170, Math.max(0, W - x(hp.t) + 10)) }}>
          <div className="mb-1 font-semibold">{tooltipTitle(hp)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="flex-1 text-ink-2">{s.label}</span>
              <span className="num font-medium">{format(hp[s.key] || 0)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-2">
        {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: s.color }} />{s.label}</span>)}
      </div>
    </div>
  );
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}

export const hhmm = (t) => fa(new Date(t).toTimeString().slice(0, 5));
