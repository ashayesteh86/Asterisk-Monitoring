// Main dashboard: concurrent-call chart, live counters, today's CDR summary, queues, trunks and server health at a glance.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useLive, useNow } from "../live.js";
import { useSession, can } from "../session.jsx";
import { buildCalls } from "../pbxview.js";
import { api } from "../api.js";
import { fa, faNum, dur, durLong, jOf, MONTHS } from "../jalali.js";
import { Icon } from "../components/ui.jsx";
import LineChart, { hhmm } from "../components/LineChart.jsx";
import BarChart from "../components/BarChart.jsx";

const RANGES = [["1h", "۱ ساعت"], ["6h", "۶ ساعت"], ["24h", "۲۴ ساعت"], ["7d", "۷ روز"], ["30d", "۳۰ روز"]];

export default function Dashboard() {
  const { me } = useSession();
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const queues = useLive((s) => s.queues);
  const [range, setRange] = useState(() => { try { return localStorage.getItem("dash.range") || "6h"; } catch { return "6h"; } });
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const liveSys = useLive((st) => st.system);

  useEffect(() => {
    let alive = true;
    const load = () => api(`/api/dashboard/series?range=${range}`).then((d) => alive && setData(d)).catch(() => {});
    load();
    const t = setInterval(load, range === "1h" || range === "6h" ? 10000 : 60000);
    try { localStorage.setItem("dash.range", range); } catch { /* ignore */ }
    return () => { alive = false; clearInterval(t); };
  }, [range]);
  useEffect(() => {
    const load = () => {
      api("/api/dashboard/summary").then(setSummary).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const calls = useMemo(() => buildCalls(peers, channels, true), [peers, channels]);
  const live = useMemo(() => {
    const c = { total: calls.length, inbound: 0, outbound: 0, internal: 0, ringing: 0 };
    for (const k of calls) { c[k.direction]++; if (k.status === "ringing") c.ringing++; }
    return c;
  }, [calls]);
  const exts = Object.values(peers).filter((p) => p.kind === "extension");
  const online = exts.filter((p) => !["offline", "unreachable"].includes(p.status)).length;
  const trunks = Object.values(peers).filter((p) => p.kind === "trunk");
  const trunksUp = trunks.filter((t) => ["online", "unmonitored", "lagged"].includes(t.status));
  const waiting = queues.reduce((s, q) => s + q.entries.length, 0);

  const long = range === "7d" || range === "30d";
  const xLabel = (t) => { if (!long) return hhmm(t); const j = jOf(new Date(t)); return fa(`${j.jm}/${j.jd}`); };
  const title = (p) => { const d = new Date(p.t); const j = jOf(d); return fa(`${j.jd} ${MONTHS[j.jm - 1]} — ${d.toTimeString().slice(0, 5)}`); };
  const pts = useMemo(() => {
    const list = data?.points || [];
    // append the live value so the chart ends "now"
    return list.length ? [...list, { t: Date.now(), peak: live.total, inbound: live.inbound, outbound: live.outbound, internal: live.internal }] : list;
  }, [data, live]);

  const t = summary?.cdr?.totals;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Live label="تماس همزمان" value={live.total} icon="pulse" tone="accent" big />
        <Live label="ورودی" value={live.inbound} icon="phoneIn" />
        <Live label="خروجی" value={live.outbound} icon="phoneOut" />
        <Live label="داخلی" value={live.internal} icon="phone" />
        <Live label="در حال زنگ" value={live.ringing} icon="phoneIn" tone="ring" />
        <Live label="منتظر در صف" value={waiting} icon="users" tone={waiting ? "talk" : undefined} to={can(me.user, "queues.view") ? "/queues" : null} />
        <Live label="داخلی آنلاین" value={`${faNum(online)}/${faNum(exts.length)}`} icon="wifi" tone="idle" to={can(me.user, "panel.view") ? "/panel" : null} />
        {can(me.user, "trunks.view")
          ? <Live label="ترانک فعال" value={`${faNum(trunksUp.length)}/${faNum(trunks.length)}`} icon="trunk" tone={trunksUp.length < trunks.length ? "ring" : "idle"} to="/trunks" />
          : <Live label="اوج امروز" value={summary?.peaks?.today ?? 0} icon="chart" />}
      </div>

      <div className="card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">تعداد تماس‌های همزمان (آنلاین)</h2>
          {summary?.peaks && (
            <span className="text-xs text-ink-3">
              اوج امروز: <b className="num text-ink">{faNum(summary.peaks.today || 0)}</b>
              {summary.peaks.today_at && <> ساعت <span className="num">{hhmm(summary.peaks.today_at)}</span></>}
              {" · "}اوج ۳۰ روز: <b className="num text-ink">{faNum(summary.peaks.month || 0)}</b>
            </span>
          )}
          <div className="flex-1" />
          <div className="flex rounded-lg border border-line p-0.5">
            {RANGES.map(([k, l]) => <button key={k} onClick={() => setRange(k)} className={`rounded-md px-2.5 py-1 text-xs ${range === k ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-surface-2"}`}>{l}</button>)}
          </div>
        </div>
        <LineChart points={pts} xLabel={xLabel} tooltipTitle={title} height={260} series={[
          { key: "peak", label: "کل تماس‌ها (حداکثر در بازه)", color: "var(--series-1)", area: true },
          { key: "inbound", label: "ورودی", color: "var(--series-2)" },
          { key: "outbound", label: "خروجی", color: "var(--series-3)" },
        ]} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        {summary?.cdr && (
          <div className="card p-4 xl:col-span-2">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-sm font-semibold">تماس‌های امروز</h2>
              <span className="flex-1" />
              {can(me.user, "reports.view") && <Link to="/reports" className="text-xs text-accent">گزارش کامل ←</Link>}
            </div>
            {summary.cdr.error ? <div className="rounded-lg bg-ring-soft px-3 py-2 text-sm text-ring">{summary.cdr.error}</div> : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Mini label="کل" value={faNum(t.total)} sub={`${faNum(t.inbound)} ورودی · ${faNum(t.outbound)} خروجی`} />
                  <Mini label="پاسخ داده شده" value={faNum(t.answered)} sub={t.total ? fa(`${Math.round((t.answered / t.total) * 100)}٪`) : ""} tone="idle" />
                  <Mini label="بی‌پاسخ / مشغول" value={faNum(t.noAnswer + t.busy + t.failed)} tone="ring" />
                  <Mini label="مجموع مکالمه" value={durLong(t.talk)} sub={`میانگین ${dur(t.avgTalk)}`} />
                </div>
                <BarChart height={180} labelEvery={1} series={[{ key: "answered", label: "پاسخ داده شده", color: "var(--series-1)" }, { key: "missed", label: "بی‌پاسخ", color: "var(--series-2)" }]}
                  data={Array.from({ length: 24 }, (_, h) => { const r = summary.cdr.byHour.find((x) => Number(x.hour) === h); return { label: fa(h), title: fa(`ساعت ${h}`), answered: r?.answered || 0, missed: (r?.total || 0) - (r?.answered || 0) }; }).filter((_, h) => h >= 7 && h <= 22)} />
              </>
            )}
          </div>
        )}

        <div className="space-y-5">
          {can(me.user, "system.view") && liveSys && <SystemMini s={liveSys} />}
          {queues.length > 0 && <QueueMini queues={queues} />}
          {can(me.user, "trunks.view") && trunks.length > 0 && (
            <div className="card">
              <div className="flex items-center border-b border-line px-4 py-3"><h2 className="flex-1 text-sm font-semibold">ترانک‌های قطع</h2><Link to="/trunks" className="text-xs text-accent">همه ←</Link></div>
              <div className="max-h-56 divide-y divide-line overflow-y-auto">
                {trunks.filter((x) => !trunksUp.includes(x)).length === 0 && <div className="px-4 py-4 text-center text-sm text-idle">همه ترانک‌ها متصل هستند</div>}
                {trunks.filter((x) => !trunksUp.includes(x)).map((x) => (
                  <div key={x.name} className="flex items-center gap-2 px-4 py-2 text-sm"><span className="size-2 rounded-full bg-talk" /><span className="flex-1 ltr text-right">{x.name}</span><span className="text-xs text-ink-3">{x.status === "unreachable" ? "Unreachable" : "نامشخص"}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Live({ label, value, icon, tone, big, to }) {
  const body = (
    <div className={`card flex h-full items-start gap-3 p-3.5 ${to ? "transition hover:shadow-md" : ""}`}>
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${tone === "accent" || !tone ? "bg-accent-soft text-accent" : `bg-${tone}-soft text-${tone}`}`}><Icon name={icon} className="size-[18px]" /></div>
      <div className="min-w-0">
        <div className="text-xs leading-4 text-ink-3">{label}</div>
        <div className={`num font-bold ${big ? "text-2xl" : "text-xl"}`}>{typeof value === "number" ? faNum(value) : value}</div>
      </div>
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

const Mini = ({ label, value, sub, tone }) => (
  <div className="rounded-xl bg-surface-2 p-3">
    <div className="text-xs text-ink-3">{label}</div>
    <div className={`num font-bold ${String(value).length > 12 ? "text-sm leading-6" : "text-lg"} ${tone ? `text-${tone}` : ""}`}>{value}</div>
    {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
  </div>
);

export function Meter({ label, pct, detail, warn = 75, danger = 90 }) {
  const tone = pct === null || pct === undefined ? "off" : pct >= danger ? "talk" : pct >= warn ? "ring" : "idle";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs"><span className="text-ink-2">{label}</span><span className={`num font-semibold text-${tone}`}>{pct === null || pct === undefined ? "—" : fa(`${pct.toFixed(0)}٪`)}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3"><div className={`h-full rounded-full bg-${tone}`} style={{ width: `${Math.min(100, pct || 0)}%` }} /></div>
      {detail && <div className="num mt-0.5 text-[11px] text-ink-3">{detail}</div>}
    </div>
  );
}

/** "live" while samples keep arriving; turns amber when the last one is old. */
export function LiveBadge({ age }) {
  const fresh = age <= 20;
  return (
    <span className={`chip ${fresh ? "bg-idle-soft text-idle" : "bg-ring-soft text-ring"}`} title={`آخرین نمونه ${fa(age)} ثانیه پیش`}>
      <span className={`size-1.5 rounded-full ${fresh ? "animate-pulse bg-idle" : "bg-ring"}`} />{fresh ? "زنده" : `${fa(age)} ثانیه پیش`}
    </span>
  );
}

export const bytes = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const u = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت", "ترابایت"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return fa(`${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`);
};

function SystemMini({ s }) {
  const now = useNow();
  const age = Math.max(0, Math.round((now - s.at) / 1000));
  const h = s.host;
  const mem = s.memory;
  const root = h?.disks?.find((d) => d.mount === "/") || h?.disks?.[0];
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">سرور استریسک</h2>
        <LiveBadge age={age} />
        <span className="flex-1" />
        <Link to="/system" className="text-xs text-accent">جزئیات ←</Link>
      </div>
      <div className="space-y-3">
        <Meter label="پردازنده (CPU)" pct={h?.cpu ?? null} detail={h?.load ? `Load: ${h.load.map((x) => x.toFixed(2)).join(" / ")}` : "از طریق AMI در دسترس نیست"} />
        <Meter label="حافظه (RAM)" pct={mem ? (mem.used / mem.total) * 100 : null} detail={mem ? `${bytes(mem.used)} از ${bytes(mem.total)}` : ""} />
        <Meter label={`دیسک ${root?.mount || ""}`} pct={root ? (root.used / root.total) * 100 : null} detail={root ? `${bytes(root.used)} از ${bytes(root.total)}` : "از طریق AMI در دسترس نیست"} />
        <div className="flex justify-between text-xs"><span className="text-ink-3">آپتایم استریسک</span><span className="num">{s.asterisk?.uptime ? durLong(s.asterisk.uptime) : "—"}</span></div>
      </div>
    </div>
  );
}

function QueueMini({ queues }) {
  const now = useNow();
  return (
    <div className="card">
      <div className="flex items-center border-b border-line px-4 py-3"><h2 className="flex-1 text-sm font-semibold">صف‌ها</h2><Link to="/queues" className="text-xs text-accent">جزئیات ←</Link></div>
      <div className="divide-y divide-line">
        {queues.map((q) => {
          const longest = q.entries.length ? Math.max(...q.entries.map((e) => (now - e.joinedAt) / 1000)) : 0;
          const free = q.members.filter((m) => m.status === "idle" && !m.paused).length;
          return (
            <div key={q.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="num font-semibold">{fa(q.name)}</span>
              <span className={`chip ${q.entries.length ? "bg-talk-soft text-talk" : "bg-surface-2 text-ink-3"}`}>{faNum(q.entries.length)} منتظر</span>
              {longest > 0 && <span className="num text-xs text-ink-3">{dur(longest)}</span>}
              <span className="flex-1" />
              <span className="text-xs text-ink-3">{faNum(free)} اپراتور آزاد از {faNum(q.members.length)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
