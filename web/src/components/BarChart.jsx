// Small stacked bar chart (SVG) with hover tooltip. series: [{key, label, color}], data: [{label, ...values}]
import { useEffect, useRef, useState } from "react";
import { faNum } from "../jalali.js";

export default function BarChart({ data, series, height = 220, format = faNum, labelEvery }) {
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const [W, setW] = useState(800);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [data.length > 0]);
  if (!data.length) return <div ref={box} className="flex items-center justify-center text-sm text-ink-3" style={{ height }}>داده‌ای برای نمایش نیست</div>;
  const H = height, padL = 8, padR = 44, padT = 12, padB = 26;
  const totals = data.map((d) => series.reduce((s, x) => s + (Number(d[x.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = iw / data.length;
  const barW = Math.max(2, Math.min(28, bw - 2));
  const y = (v) => padT + ih - (v / top) * ih;
  const every = labelEvery || Math.ceil(data.length / Math.max(4, Math.floor(W / 60)));
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  return (
    <div className="relative" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height, direction: "ltr" }} role="img"
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <text x={W - padR + 6} y={y(t) + 4} fontSize="11" fill="var(--ink-3)" textAnchor="start">{faNum(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          // RTL: first item on the right
          const x = W - padR - (i + 1) * bw + (bw - barW) / 2;
          let acc = 0;
          const segs = series.map((s, si) => {
            const v = Number(d[s.key]) || 0;
            const y0 = y(acc), y1 = y(acc + v);
            acc += v;
            if (v <= 0) return null;
            const gap = si > 0 ? 1 : 0;
            return <rect key={s.key} x={x} y={y1} width={barW} height={Math.max(0, y0 - y1 - gap)} rx={si === series.length - 1 || !series.slice(si + 1).some((n) => Number(d[n.key]) > 0) ? Math.min(4, barW / 2) : 0}
              fill={s.color} opacity={hover === null || hover === i ? 1 : 0.45} />;
          });
          return (
            <g key={i}>
              {segs}
              <rect x={W - padR - (i + 1) * bw} y={padT} width={bw} height={ih} fill="transparent" onMouseEnter={() => setHover(i)} />
              {i % every === 0 && <text x={x + barW / 2} y={H - 8} fontSize="11" fill="var(--ink-3)" textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke="var(--ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover !== null && (
        <div className="card pointer-events-none absolute top-1 z-10 min-w-36 px-3 py-2 text-xs shadow-lg"
          style={{ right: Math.min(W - 160, padR + (hover + 0.5) * bw + 8) }}>
          <div className="mb-1 font-semibold">{data[hover].title || data[hover].label}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="flex-1 text-ink-2">{s.label}</span>
              <span className="num font-medium">{format(data[hover][s.key] || 0)}</span>
            </div>
          ))}
          {series.length > 1 && <div className="mt-1 flex justify-between border-t border-line pt-1"><span className="text-ink-2">جمع</span><span className="num font-medium">{format(totals[hover])}</span></div>}
        </div>
      )}
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-2">
          {series.map((s) => <span key={s.key} className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
    </div>
  );
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
