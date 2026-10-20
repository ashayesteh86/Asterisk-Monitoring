// Operator panel: every extension with its phone model and live call state, active calls, quick actions.
import { useMemo, useState } from "react";
import { useLive, useNow } from "../live.js";
import { buildExtensions, buildCalls, channelStatus, otherParty, STATUS } from "../pbxview.js";
import { useSession, useDial, hasRole } from "../session.jsx";
import { api } from "../api.js";
import { fa, faNum, dur } from "../jalali.js";
import { Icon, Modal, Empty, useToast, Field } from "../components/ui.jsx";
import PhoneIcon from "../components/PhoneIcon.jsx";

const FILTERS = [
  { id: "all", label: "همه" },
  { id: "busy", label: "در مکالمه" },
  { id: "ringing", label: "در حال زنگ" },
  { id: "idle", label: "آزاد" },
  { id: "offline", label: "خاموش" },
];
const DIR = { inbound: { label: "ورودی", icon: "phoneIn" }, outbound: { label: "خروجی", icon: "phoneOut" }, internal: { label: "داخلی", icon: "phone" } };

function Timer({ since }) {
  const now = useNow();
  return <span className="num">{since ? dur((now - since) / 1000) : ""}</span>;
}

function StatusChip({ status }) {
  const s = STATUS[status] || STATUS.idle;
  return <span className={`chip bg-${s.color}-soft text-${s.color}`}><span className={`size-1.5 rounded-full bg-${s.color}`} />{s.label}</span>;
}

export default function Panel() {
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const dahdi = useLive((s) => s.dahdi);
  const { me, lookup } = useSession();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("panel.compact") === "1"; } catch { return false; } });
  const [selected, setSelected] = useState(null);
  const [dragOver, setDragOver] = useState(null);

  const exts = useMemo(() => buildExtensions(peers, channels), [peers, channels]);
  const calls = useMemo(() => buildCalls(peers, channels, me.dial.hideLocal), [peers, channels, me.dial.hideLocal]);
  const trunks = useMemo(() => Object.values(peers).filter((p) => p.kind === "trunk"), [peers]);

  const counts = useMemo(() => {
    const c = { total: exts.length, online: 0, busy: 0, ringing: 0, offline: 0 };
    for (const e of exts) {
      if (e.status === "offline" || e.status === "unreachable") c.offline++; else c.online++;
      if (["talking", "hold", "dialing"].includes(e.status)) c.busy++;
      if (e.status === "ringing") c.ringing++;
    }
    return c;
  }, [exts]);
  const callCounts = useMemo(() => ({
    inbound: calls.filter((c) => c.direction === "inbound").length,
    outbound: calls.filter((c) => c.direction === "outbound").length,
    internal: calls.filter((c) => c.direction === "internal").length,
  }), [calls]);

  const shown = exts.filter((e) => {
    if (filter === "busy" && !["talking", "hold", "dialing"].includes(e.status)) return false;
    if (filter === "ringing" && e.status !== "ringing") return false;
    if (filter === "idle" && e.status !== "idle") return false;
    if (filter === "offline" && !["offline", "unreachable"].includes(e.status)) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return e.name.includes(s) || e.callerName.toLowerCase().includes(s) || e.phone.model.toLowerCase().includes(s) || e.ip.includes(s);
  });

  const transfer = async (fromExt, toExt) => {
    const ch = fromExt.calls.find((c) => c.state === 6 && c.bridged?.length);
    const remote = ch && channels[ch.bridged[0]];
    if (!remote) return toast("فقط تماس برقرارشده را می‌توان با کشیدن منتقل کرد", "error");
    try {
      await api("/api/calls/transfer", { method: "POST", body: { channel: remote.name, target: toExt.name } });
      toast(`تماس از ${fa(fromExt.name)} به ${fa(toExt.name)} منتقل شد`);
    } catch (e) { toast(e.message, "error"); }
  };

  const setCompactPersist = (v) => { setCompact(v); try { localStorage.setItem("panel.compact", v ? "1" : "0"); } catch { /* ignore */ } };
  const sel = selected && exts.find((e) => e.name === selected);
  const dahdiBusy = dahdi.filter((d) => d.active).length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="داخلی‌ها" value={counts.total} sub={`${faNum(counts.online)} آنلاین`} icon="users" />
        <Stat label="در مکالمه" value={counts.busy} tone="talk" icon="phone" />
        <Stat label="در حال زنگ" value={counts.ringing} tone="ring" icon="phoneIn" />
        <Stat label="خاموش / ثبت نشده" value={counts.offline} tone="off" icon="wifi" />
        <Stat label="تماس‌های فعال" value={calls.length} sub={`${faNum(callCounts.inbound)} ورودی · ${faNum(callCounts.outbound)} خروجی · ${faNum(callCounts.internal)} داخلی`} icon="pulse" />
        <Stat label="ترانک‌ها" value={`${faNum(trunks.filter((t) => t.status === "online" || t.status === "unmonitored").length)}/${faNum(trunks.length)}`} sub={dahdi.length ? `E1: ${faNum(dahdiBusy)} از ${faNum(dahdi.length)} کانال مشغول` : "فعال / کل"} icon="trunk" />
      </div>

      <div className="flex flex-col gap-5 2xl:flex-row">
        <section className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Icon name="search" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
              <input className="input pr-9" placeholder="جستجوی داخلی، نام، مدل، IP" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button key={f.id} onClick={() => setFilter(f.id)} className={`btn btn-sm ${filter === f.id ? "!border-accent !bg-accent-soft !text-accent" : ""}`}>{f.label}</button>
              ))}
            </div>
            <div className="flex-1" />
            <div className="flex rounded-lg border border-line p-0.5">
              <button className={`rounded-md px-2 py-1 ${!compact ? "bg-surface-3" : ""}`} onClick={() => setCompactPersist(false)} title="کارت"><Icon name="grid" className="size-4" /></button>
              <button className={`rounded-md px-2 py-1 ${compact ? "bg-surface-3" : ""}`} onClick={() => setCompactPersist(true)} title="فشرده"><Icon name="list" className="size-4" /></button>
            </div>
          </div>

          {!exts.length ? (
            <div className="card"><Empty icon="server" title="هنوز داخلی‌ای دریافت نشده">اتصال AMI را در «تنظیمات» وارد کنید. داخلی‌ها از SIPpeers / PJSIPShowEndpoints خوانده می‌شوند.</Empty></div>
          ) : (
            <div className={`grid gap-2.5 ${compact ? "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(225px,1fr))]"}`}>
              {shown.map((e) => (
                <ExtCard key={e.name} ext={e} compact={compact} channels={channels} peers={peers} lookup={lookup}
                  onOpen={() => setSelected(e.name)} dragOver={dragOver === e.name}
                  onDragOver={(ev) => { if (ev.dataTransfer.types.includes("text/ext") && e.status !== "offline") { ev.preventDefault(); setDragOver(e.name); } }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(ev) => { ev.preventDefault(); setDragOver(null); const from = exts.find((x) => x.name === ev.dataTransfer.getData("text/ext")); if (from && from.name !== e.name) transfer(from, e); }} />
              ))}
            </div>
          )}
          {exts.length > 0 && <p className="mt-3 text-xs text-ink-3">راهنما: برای انتقال تماس، کارت داخلیِ در حال مکالمه را بکشید و روی داخلی مقصد رها کنید.</p>}
        </section>

        <aside className="w-full shrink-0 2xl:w-96">
          <div className="card">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">تماس‌های فعال</h2>
              <span className="chip bg-surface-2 text-ink-2 num">{faNum(calls.length)}</span>
            </div>
            <div className="max-h-[70vh] divide-y divide-line overflow-y-auto">
              {calls.length === 0 && <Empty icon="phone" title="تماس فعالی نیست" />}
              {calls.map((c) => <CallRow key={c.id} call={c} peers={peers} channels={channels} lookup={lookup} onOpen={(ext) => setSelected(ext)} />)}
            </div>
          </div>
        </aside>
      </div>

      {sel && <ExtDetail ext={sel} onClose={() => setSelected(null)} channels={channels} peers={peers} lookup={lookup} />}
    </div>
  );
}

function Stat({ label, value, sub, tone, icon }) {
  return (
    <div className="card flex items-start gap-3 p-3.5">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${tone ? `bg-${tone}-soft text-${tone}` : "bg-accent-soft text-accent"}`}><Icon name={icon} className="size-[18px]" /></div>
      <div className="min-w-0">
        <div className="text-xs text-ink-3">{label}</div>
        <div className="num text-xl font-bold leading-7">{typeof value === "number" ? faNum(value) : value}</div>
        {sub && <div className="truncate text-[11px] text-ink-3">{sub}</div>}
      </div>
    </div>
  );
}

function ExtCard({ ext, compact, channels, peers, lookup, onOpen, dragOver, onDragOver, onDragLeave, onDrop }) {
  const s = STATUS[ext.status] || STATUS.idle;
  const call = ext.calls[0];
  const other = call && otherParty(call, channels, peers);
  const otherName = other && (lookup(other.number) || other.name);
  const draggable = ext.calls.some((c) => c.state === 6 && c.bridged?.length);
  const off = ext.status === "offline" || ext.status === "unreachable";
  const ring = `border-${s.color}`;
  return (
    <button onClick={onOpen} draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.setData("text/ext", ext.name); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      className={`card group relative overflow-hidden text-right transition hover:shadow-md ${ext.status === "ringing" ? "ringing" : ""} ${dragOver ? "!border-accent ring-2 ring-accent" : ""} ${off ? "opacity-70" : ""} ${draggable ? "cursor-grab" : ""}`}>
      <span className={`absolute inset-y-0 right-0 w-1 bg-${s.color}`} />
      {compact ? (
        <div className="flex items-center gap-2 py-2 pl-2 pr-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5"><span className="num font-bold">{fa(ext.name)}</span>{call && <span className={`text-[11px] text-${s.color} num`}><Timer since={call.answeredAt || call.startedAt} /></span>}</div>
            <div className="truncate text-xs text-ink-3">{other ? (otherName || fa(other.number) || s.label) : ext.callerName || "—"}</div>
          </div>
          <PhoneIcon phone={ext.phone} status={ext.status} className="size-7 shrink-0" />
        </div>
      ) : (
        <div className="p-3 pr-4">
          <div className="flex items-start gap-3">
            <PhoneIcon phone={ext.phone} status={ext.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="num text-lg font-bold leading-6">{fa(ext.name)}</span>
                {ext.external && <span className="chip bg-surface-2 px-1.5 text-[10px] text-ink-3">شهری</span>}
              </div>
              <div className="truncate text-sm text-ink-2">{ext.callerName || "بدون نام"}</div>
              <div className="truncate text-[11px] text-ink-3 ltr text-right" title={ext.userAgent}>{ext.phone.model || (off ? "—" : "مدل نامشخص")}</div>
            </div>
          </div>
          <div className={`mt-2.5 flex min-h-[38px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs bg-${s.color}-soft text-${s.color}`}>
            {call ? (
              <>
                <Icon name={call.direction === "in" ? "phoneIn" : "phoneOut"} className={`size-4 shrink-0 ${ext.status === "ringing" ? "shake" : ""}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{otherName || (other.number ? fa(other.number) : s.label)}</div>
                  {otherName && other.number && <div className="num truncate opacity-80">{fa(other.number)}</div>}
                </div>
                <span className="num font-semibold"><Timer since={call.answeredAt || call.startedAt} /></span>
                {ext.calls.length > 1 && <span className="chip bg-surface px-1.5 text-[10px]">+{fa(ext.calls.length - 1)}</span>}
              </>
            ) : (
              <>
                <span className={`size-2 rounded-full bg-${s.color}`} />
                <span className="flex-1">{s.label}</span>
                {!off && ext.latency != null && <span className="num opacity-75">{fa(ext.latency)}ms</span>}
              </>
            )}
          </div>
        </div>
      )}
      <span className={`hidden ${ring}`} />
    </button>
  );
}

function CallRow({ call, peers, channels, lookup, onOpen }) {
  const d = DIR[call.direction];
  const ext = call.exts[0];
  const extPeer = ext && peers[ext.peer];
  const other = ext ? otherParty(ext, channels, peers) : { number: call.channels[0].callerNum, name: "" };
  const name = lookup(other.number) || other.name;
  const trunkName = call.trunk ? (call.trunk.tech === "DAHDI" ? "E1 / DAHDI" : call.trunk.peer) : "";
  const st = STATUS[call.status];
  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
      <div className={`flex size-9 shrink-0 items-center justify-center rounded-full bg-${st.color}-soft text-${st.color}`}><Icon name={d.icon} className={`size-4 ${call.status === "ringing" ? "shake" : ""}`} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          {ext ? <button className="num font-semibold hover:text-accent" onClick={() => onOpen(ext.peer)}>{fa(ext.peer)}</button> : <span className="text-ink-3">—</span>}
          {extPeer?.callerName && <span className="truncate text-xs text-ink-3">{extPeer.callerName}</span>}
          <Icon name="chevronL" className="size-3 text-ink-3" />
          <span className="truncate">{name || (other.number ? fa(other.number) : "")}</span>
          {call.exts[1] && <button className="num font-semibold hover:text-accent" onClick={() => onOpen(call.exts[1].peer)}>{fa(call.exts[1].peer)}</button>}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-3">
          <span>{d.label}</span>
          {name && other.number && <span className="num">{fa(other.number)}</span>}
          {trunkName && <span className="ltr">via {trunkName}</span>}
          <span className={`text-${st.color}`}>{st.label}</span>
        </div>
      </div>
      <div className="num text-sm font-medium"><Timer since={call.answeredAt || call.startedAt} /></div>
    </div>
  );
}

function ExtDetail({ ext, onClose, channels, peers, lookup }) {
  const { me } = useSession();
  const dial = useDial();
  const toast = useToast();
  const [target, setTarget] = useState("");
  const supervisor = hasRole(me.user, "supervisor");
  const act = async (path, body, okText) => {
    try { await api(path, { method: "POST", body }); toast(okText); } catch (e) { toast(e.message, "error"); }
  };
  const rows = [
    ["وضعیت", <StatusChip status={ext.status} />],
    ["مدل تلفن", <span className="ltr">{ext.phone.model || "—"}</span>],
    ["فریمور", <span className="ltr num">{ext.phone.firmware || "—"}</span>],
    ["User-Agent", <span className="ltr break-all text-xs">{ext.userAgent || "—"}</span>],
    ["آدرس IP", <span className="ltr num">{ext.ip ? `${ext.ip}${ext.port ? `:${ext.port}` : ""}` : "—"}</span>],
    ["تأخیر (Qualify)", ext.latency != null ? <span className="num">{fa(ext.latency)} ms</span> : "—"],
    ["فناوری / Context", <span className="ltr">{ext.tech} · {ext.context || "—"}</span>],
    ["کدک‌ها", <span className="ltr text-xs">{ext.codecs || "—"}</span>],
  ];
  return (
    <Modal open onClose={onClose} title={`داخلی ${fa(ext.name)} — ${ext.callerName || "بدون نام"}`} wide>
      <div className="flex flex-col gap-5 md:flex-row">
        <div className="flex flex-col items-center gap-2 md:w-40">
          <PhoneIcon phone={ext.phone} status={ext.status} className="size-24" />
          <div className="text-center text-sm font-medium ltr">{ext.phone.vendor || "—"}</div>
          {me.user.extension && me.user.extension !== ext.name && ext.status !== "offline" && (
            <button className="btn btn-primary btn-sm mt-1" onClick={() => dial(ext.name, ext.callerName || ext.name)}><Icon name="phone" className="size-4" />تماس با این داخلی</button>
          )}
        </div>
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, v]) => [<dt key={`k${k}`} className="text-ink-3">{k}</dt>, <dd key={`v${k}`} className="min-w-0">{v}</dd>])}
        </dl>
      </div>

      <h4 className="mb-2 mt-6 text-sm font-semibold">تماس‌های جاری</h4>
      {ext.calls.length === 0 && <div className="rounded-lg bg-surface-2 px-3 py-4 text-center text-sm text-ink-3">این داخلی در حال حاضر تماسی ندارد.</div>}
      <div className="space-y-2">
        {ext.calls.map((c) => {
          const o = otherParty(c, channels, peers);
          const st = STATUS[channelStatus(c)];
          const remote = c.bridged?.[0];
          return (
            <div key={c.name} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Icon name={c.direction === "in" ? "phoneIn" : "phoneOut"} className={`size-4 text-${st.color}`} />
                <span className="font-medium">{lookup(o.number) || o.name || fa(o.number) || "نامشخص"}</span>
                {(lookup(o.number) || o.name) && o.number && <span className="num text-sm text-ink-3">{fa(o.number)}</span>}
                <span className={`chip bg-${st.color}-soft text-${st.color}`}>{st.label}</span>
                <span className="flex-1" />
                <span className="num font-semibold"><Timer since={c.answeredAt || c.startedAt} /></span>
              </div>
              <div className="mt-1 text-[11px] text-ink-3 ltr text-right">{c.name}{remote ? ` ⇄ ${remote}` : ""}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {supervisor && c.state === 6 && c.app !== "ChanSpy" && (
                  <>
                    <button className="btn btn-sm" onClick={() => act("/api/calls/spy", { channel: c.name, mode: "listen" }, `شنود: ابتدا داخلی ${fa(me.user.extension)} زنگ می‌خورد`)}><Icon name="ear" className="size-4" />شنود</button>
                    <button className="btn btn-sm" onClick={() => act("/api/calls/spy", { channel: c.name, mode: "whisper" }, "نجوا (فقط داخلی صدای شما را می‌شنود)")}><Icon name="whisper" className="size-4" />نجوا</button>
                    <button className="btn btn-sm" onClick={() => act("/api/calls/spy", { channel: c.name, mode: "barge" }, "ورود به مکالمه (سه‌طرفه)")}><Icon name="barge" className="size-4" />ورود به مکالمه</button>
                  </>
                )}
                {supervisor && <button className="btn btn-sm btn-danger" onClick={() => act("/api/calls/hangup", { channel: c.name }, "تماس قطع شد")}><Icon name="hangup" className="size-4" />قطع</button>}
              </div>
              {remote && c.state === 6 && (supervisor || ext.name === me.user.extension) && (
                <form className="mt-3 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); act("/api/calls/transfer", { channel: remote, target }, `منتقل شد به ${fa(target)}`); }}>
                  <Field label="انتقال طرف مقابل به" className="flex-1"><input className="input num ltr text-left" placeholder="مثلاً 105" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d*#]/g, ""))} /></Field>
                  <button className="btn" disabled={!target}><Icon name="transfer" className="size-4" />انتقال</button>
                </form>
              )}
            </div>
          );
        })}
      </div>
      {supervisor && !me.user.extension && <p className="mt-4 text-xs text-ring">برای شنود، داخلی شما باید در پروفایل کاربری ثبت شده باشد.</p>}
      {supervisor && <p className="mt-3 text-xs text-ink-3">در حین شنود با کلیدهای ۴ (شنود)، ۵ (نجوا) و ۶ (ورود به مکالمه) روی گوشی می‌توانید حالت را عوض کنید. همه عملیات شنود در گزارش رخدادها ثبت می‌شود.</p>}
    </Modal>
  );
}
