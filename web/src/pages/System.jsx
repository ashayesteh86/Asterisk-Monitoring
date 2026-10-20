// Asterisk server health: CPU, RAM, swap, disks, load, uptime, service processes and Asterisk core status.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useSession, can } from "../session.jsx";
import { useLive } from "../live.js";
import { fa, faNum, durLong, jFromSql } from "../jalali.js";
import { Icon, Spinner, Empty } from "../components/ui.jsx";
import LineChart, { hhmm } from "../components/LineChart.jsx";
import { Meter, bytes } from "./Dashboard.jsx";

export default function SystemPage() {
  const { me } = useSession();
  const ami = useLive((s) => s.ami);
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh) => { setBusy(true); return api(`/api/system${refresh ? "?refresh=1" : ""}`).then(setD).catch(() => {}).finally(() => setBusy(false)); };
  useEffect(() => { load(); const t = setInterval(() => load(), 15000); return () => clearInterval(t); }, []);

  if (!d) return <div className="p-12 text-center"><Spinner /></div>;
  const s = d.latest;
  if (!s) return <div className="card"><Empty icon="server" title="هنوز اطلاعاتی از سرور دریافت نشده" /></div>;
  const h = s.host;
  const a = s.asterisk || {};
  const mem = s.memory;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">وضعیت سرور استریسک</h1>
        {h?.host && <span className="chip bg-surface-2 text-ink-2 ltr">{h.host}</span>}
        <div className="flex-1" />
        <span className="text-xs text-ink-3">آخرین نمونه: <span className="num">{hhmm(s.at)}</span> · روش: {s.method === "ssh" ? "SSH" : s.method === "ami" ? "AMI" : "خاموش"}</span>
        <button className="btn btn-sm" onClick={() => load(true)} disabled={busy}>{busy ? <Spinner className="size-4" /> : <Icon name="refresh" className="size-4" />}به‌روزرسانی</button>
      </div>

      {s.error && (
        <div className="card border-ring bg-ring-soft px-4 py-3 text-sm text-ring">
          <div className="flex items-start gap-2"><Icon name="alert" className="mt-0.5 size-4 shrink-0" /><div>
            <div className="font-medium">CPU، دیسک و سرویس‌ها خوانده نشد</div>
            <div className="mt-1 leading-6">{s.error}</div>
            {s.memory?.approximate && <div className="mt-1 text-xs">مقدار RAM از دستور <span className="ltr">core show sysinfo</span> استریسک خوانده شده است.</div>}
            {can(me.user, "settings.manage") && <Link to="/settings" className="mt-1 inline-block text-xs font-medium underline">تنظیمات › مانیتورینگ سرور</Link>}
          </div></div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Gauge title="پردازنده (CPU)" icon="pulse" pct={h?.cpu} lines={[h?.cpus && `${faNum(h.cpus)} هسته`, h?.load && `Load: ${h.load.map((x) => x.toFixed(2)).join(" / ")}`, h?.asteriskProcess && `فرایند asterisk: ${fa(h.asteriskProcess.cpu.toFixed(1))}٪`]} />
        <Gauge title="حافظه (RAM)" icon="server" pct={mem ? (mem.used / mem.total) * 100 : null} lines={[mem && `${bytes(mem.used)} از ${bytes(mem.total)}`, mem && `آزاد: ${bytes(mem.available)}`, h?.asteriskProcess && `asterisk: ${bytes(h.asteriskProcess.rss)}`]} />
        <Gauge title="Swap" icon="server" pct={s.swap?.total ? (s.swap.used / s.swap.total) * 100 : s.swap ? 0 : null} lines={[s.swap && (s.swap.total ? `${bytes(s.swap.used)} از ${bytes(s.swap.total)}` : "Swap تعریف نشده")]} />
        <div className="card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Icon name="calendar" className="size-4 text-accent" />زمان کارکرد</div>
          <dl className="space-y-2 text-sm">
            <Row k="سرور (Uptime)" v={h?.uptime ? durLong(h.uptime) : "—"} />
            <Row k="استریسک" v={a.uptime ? durLong(a.uptime) : "—"} />
            <Row k="آخرین reload" v={a.sinceReload ? `${durLong(a.sinceReload)} پیش` : "—"} />
            <Row k="شروع استریسک" v={a.startup ? jFromSql(a.startup) : "—"} />
          </dl>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">مصرف CPU و RAM (۶ ساعت اخیر)</h2>
          <LineChart points={d.history.map((x) => ({ ...x, t: x.at }))} height={200} yMax={100} xLabel={hhmm} tooltipTitle={(p) => hhmm(p.t)}
            format={(v) => fa(`${Number(v).toFixed(1)}٪`)}
            series={[{ key: "cpu", label: "CPU ٪", color: "var(--series-1)", area: true }, { key: "mem", label: "RAM ٪", color: "var(--series-2)" }]} />
        </div>
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">دیسک‌ها</h2>
          {!h?.disks?.length ? <div className="text-sm text-ink-3">اطلاعات دیسک در دسترس نیست</div> : (
            <div className="space-y-3">{h.disks.map((x) => <Meter key={x.mount} label={<span className="ltr">{x.mount}</span>} pct={(x.used / x.total) * 100} detail={`${bytes(x.used)} از ${bytes(x.total)} · آزاد ${bytes(x.total - x.used)}`} warn={80} danger={92} />)}</div>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="card">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">سرویس‌ها</div>
          {!h?.services?.length ? <div className="px-4 py-4 text-sm text-ink-3">وضعیت سرویس‌ها فقط از طریق SHELL/SSH خوانده می‌شود</div> : (
            <ul className="divide-y divide-line">
              {h.services.map((x) => (
                <li key={x.label} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className={`size-2.5 rounded-full ${x.up ? "bg-idle" : "bg-talk"}`} />
                  <span className="flex-1 ltr text-right">{x.label}</span>
                  <span className={`chip ${x.up ? "bg-idle-soft text-idle" : "bg-talk-soft text-talk"}`}>{x.up ? "در حال اجرا" : "متوقف"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">استریسک</div>
          <dl className="space-y-2 p-4 text-sm">
            <Row k="اتصال AMI" v={<span className={ami?.status === "connected" ? "text-idle" : "text-talk"}>{ami?.status === "connected" ? "متصل" : "قطع"}</span>} />
            <Row k="نسخه" v={<span className="ltr">{a.version || ami?.version || "—"}</span>} />
            <Row k="تماس‌های جاری" v={faNum(a.currentCalls ?? 0)} />
            <Row k="تماس‌های پردازش‌شده" v={a.processed ? faNum(a.processed) : "—"} />
            <Row k="تعداد فرایندها" v={a.sysinfo?.processes ? faNum(a.sysinfo.processes) : "—"} />
          </dl>
        </div>
        <div className="card">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">درایورهای کانال</div>
          {!a.modules?.length ? <div className="px-4 py-4 text-sm text-ink-3">—</div> : (
            <ul className="max-h-64 divide-y divide-line overflow-y-auto">
              {a.modules.map((m) => (
                <li key={m.name} className="flex items-center gap-2 px-4 py-2 text-xs">
                  <span className={`size-2 rounded-full ${m.status === "Running" ? "bg-idle" : "bg-talk"}`} />
                  <span className="font-medium ltr">{m.name}</span>
                  <span className="flex-1 truncate text-ink-3 ltr text-right">{m.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const Row = ({ k, v }) => <div className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="num text-left">{v}</dd></div>;

function Gauge({ title, icon, pct, lines }) {
  const has = pct !== null && pct !== undefined;
  const tone = !has ? "off" : pct >= 90 ? "talk" : pct >= 75 ? "ring" : "idle";
  const r = 34, c = 2 * Math.PI * r;
  return (
    <div className="card flex items-center gap-4 p-4">
      <svg viewBox="0 0 80 80" className="size-20 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="8" />
        {has && <circle cx="40" cy="40" r={r} fill="none" stroke={`var(--st-${tone})`} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(Math.min(100, pct) / 100) * c} ${c}`} />}
        <text x="40" y="45" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--ink)" transform="rotate(90 40 40)">{has ? fa(`${Math.round(pct)}٪`) : "—"}</text>
      </svg>
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><Icon name={icon} className="size-4 text-accent" />{title}</div>
        {lines.filter(Boolean).map((l, i) => <div key={i} className="num truncate text-xs text-ink-3">{l}</div>)}
        {!has && <div className="text-xs text-ink-3">در دسترس نیست</div>}
      </div>
    </div>
  );
}
