// Overview of every PBX server the user may see: connection, extensions, calls, trunks, queues and host health.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useSession, can } from "../session.jsx";
import { fa, faNum, durLong } from "../jalali.js";
import { Icon, Spinner, Empty } from "../components/ui.jsx";

const AMI = { connected: ["متصل", "idle"], connecting: ["در حال اتصال", "ring"], error: ["قطع", "talk"], disabled: ["غیرفعال", "off"] };

export default function Servers() {
  const { me, server, selectServer } = useSession();
  const nav = useNavigate();
  const [list, setList] = useState(null);
  useEffect(() => {
    const load = () => api("/api/servers/overview").then(setList).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const open = (id, to = "/") => { selectServer(id); nav(to); };

  if (!list) return <div className="p-12 text-center"><Spinner /></div>;
  const sum = list.reduce((a, s) => ({ calls: a.calls + s.calls.total, online: a.online + s.extensions.online, exts: a.exts + s.extensions.total,
    up: a.up + (s.enabled && s.ami.status === "connected" ? 1 : 0), waiting: a.waiting + (s.queues?.waiting || 0) }), { calls: 0, online: 0, exts: 0, up: 0, waiting: 0 });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">همه سرورها</h1>
        <div className="flex-1" />
        {can(me.user, "settings.manage") && <Link to="/settings" state={{ tab: "servers" }} className="btn btn-sm"><Icon name="settings" className="size-4" />مدیریت سرورها</Link>}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="سرورهای متصل" value={`${faNum(sum.up)}/${faNum(list.length)}`} tone={sum.up < list.length ? "ring" : "idle"} />
        <Tile label="تماس‌های همزمان (کل)" value={faNum(sum.calls)} />
        <Tile label="داخلی‌های آنلاین" value={`${faNum(sum.online)}/${faNum(sum.exts)}`} />
        <Tile label="منتظر در صف‌ها" value={faNum(sum.waiting)} tone={sum.waiting ? "talk" : undefined} />
        <Tile label="سرور انتخاب‌شده" value={server?.name || "—"} small />
      </div>

      {list.length === 0 ? <div className="card"><Empty icon="server" title="سروری تعریف نشده است" /></div> : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((s) => {
            const st = s.enabled ? s.ami.status : "disabled";
            const [label, tone] = AMI[st] || AMI.error;
            const active = server?.id === s.id;
            return (
              <div key={s.id} className={`card flex flex-col ${active ? "ring-2 ring-accent" : ""}`}>
                <div className="flex items-start gap-3 border-b border-line p-4">
                  <div className={`flex size-10 items-center justify-center rounded-xl bg-${tone}-soft text-${tone}`}><Icon name="server" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-bold">{s.name}</span>
                      {active && <span className="chip bg-accent-soft text-accent">انتخاب‌شده</span>}
                    </div>
                    <div className="truncate text-xs text-ink-3 ltr text-right">{s.ami.host || "بدون آدرس"}{s.ami.version ? ` · Asterisk ${s.ami.version}` : ""}</div>
                  </div>
                  <span className={`chip bg-${tone}-soft text-${tone}`}><span className={`size-1.5 rounded-full bg-${tone}`} />{label}</span>
                </div>
                {st === "error" && s.ami.error && <div className="bg-talk-soft px-4 py-2 text-xs text-talk">{s.ami.error}</div>}

                <div className="grid flex-1 grid-cols-2 gap-px bg-line">
                  <Cell label="تماس همزمان" value={faNum(s.calls.total)} sub={`${faNum(s.calls.inbound)} ورودی · ${faNum(s.calls.outbound)} خروجی · ${faNum(s.calls.internal)} داخلی`} />
                  <Cell label="داخلی‌ها" value={`${faNum(s.extensions.online)}/${faNum(s.extensions.total)}`} sub="آنلاین / کل" />
                  {s.trunks && <Cell label="ترانک‌ها" value={`${faNum(s.trunks.up)}/${faNum(s.trunks.total)}`} sub="متصل / کل" tone={s.trunks.up < s.trunks.total ? "ring" : undefined} />}
                  {s.queues && <Cell label="صف‌ها" value={faNum(s.queues.waiting)} sub={`منتظر در ${faNum(s.queues.count)} صف`} tone={s.queues.waiting ? "talk" : undefined} />}
                  {s.peakToday !== null && <Cell label="اوج تماس امروز" value={faNum(s.peakToday || 0)} />}
                  {s.system && <Cell label="سرور" value={s.system.cpu !== null ? fa(`CPU ${Math.round(s.system.cpu)}٪`) : "—"}
                    sub={[s.system.mem !== null && fa(`RAM ${Math.round(s.system.mem * 100)}٪`), s.system.disk !== null && fa(`دیسک ${Math.round(s.system.disk * 100)}٪`), s.system.uptime && `آپتایم ${durLong(s.system.uptime)}`].filter(Boolean).join(" · ") || "اطلاعات سرور در دسترس نیست"} />}
                </div>

                <div className="flex flex-wrap gap-2 border-t border-line p-3">
                  <button className="btn btn-primary btn-sm" onClick={() => open(s.id)}><Icon name="chart" className="size-4" />داشبورد</button>
                  {can(me.user, "calls.view") && <button className="btn btn-sm" onClick={() => open(s.id, "/calls")}>تماس‌ها</button>}
                  {can(me.user, "panel.view") && <button className="btn btn-sm" onClick={() => open(s.id, "/panel")}>پنل اپراتور</button>}
                  {can(me.user, "reports.view") && <button className="btn btn-sm" onClick={() => open(s.id, "/reports")}>گزارش</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const Tile = ({ label, value, tone, small }) => (
  <div className="card p-3.5"><div className="text-xs text-ink-3">{label}</div><div className={`num truncate font-bold ${small ? "text-base leading-7" : "text-xl"} ${tone ? `text-${tone}` : ""}`}>{value}</div></div>
);
const Cell = ({ label, value, sub, tone }) => (
  <div className="bg-surface px-4 py-3">
    <div className="text-[11px] text-ink-3">{label}</div>
    <div className={`num text-lg font-bold ${tone ? `text-${tone}` : ""}`}>{value}</div>
    {sub && <div className="num text-[11px] text-ink-3">{sub}</div>}
  </div>
);
