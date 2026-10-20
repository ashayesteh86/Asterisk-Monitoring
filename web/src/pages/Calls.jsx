// Live calls: every active conversation with direction, parties, trunk, duration, and hangup / listen / whisper / barge.
import { useMemo, useState } from "react";
import { useLive, useNow } from "../live.js";
import { useSession, can, inScope, callInScope } from "../session.jsx";
import { buildCalls, otherParty, STATUS } from "../pbxview.js";
import { api } from "../api.js";
import { fa, faNum, dur } from "../jalali.js";
import { Icon, Empty, useToast, Modal } from "../components/ui.jsx";

const DIR = { inbound: { label: "ورودی", icon: "phoneIn" }, outbound: { label: "خروجی", icon: "phoneOut" }, internal: { label: "داخلی", icon: "phone" } };
const SPY = { listen: { label: "شنود", icon: "ear", hint: "فقط می‌شنوید" }, whisper: { label: "نجوا", icon: "whisper", hint: "فقط داخلی صدای شما را می‌شنود" }, barge: { label: "ورود به مکالمه", icon: "barge", hint: "هر دو طرف صدای شما را می‌شنوند" } };

export default function Calls() {
  const { me, lookup } = useSession();
  const toast = useToast();
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const now = useNow();
  const [q, setQ] = useState("");
  const [dir, setDir] = useState("");
  const [state, setState] = useState("");
  const [spyFrom, setSpyFrom] = useState(me.user.extension || "");
  const [confirm, setConfirm] = useState(null);

  const all = useMemo(() => buildCalls(peers, channels, me.dial.hideLocal), [peers, channels, me.dial.hideLocal]);
  const calls = all.filter((c) => callInScope(me.user, "calls", c.exts.map((e) => e.peer)));
  const shown = calls.filter((c) => {
    if (dir && c.direction !== dir) return false;
    if (state && c.status !== state) return false;
    if (!q) return true;
    const hay = c.channels.map((x) => `${x.peer} ${x.callerNum} ${x.connectedNum} ${x.exten} ${peers[x.peer]?.callerName || ""} ${lookup(x.callerNum)} ${lookup(x.connectedNum)}`).join(" ");
    return hay.toLowerCase().includes(q.toLowerCase());
  });
  const dialExts = Object.values(peers).filter((p) => p.kind === "extension" && inScope(me.user, "dial", p.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const canSpy = can(me.user, "calls.spy");
  const canHang = can(me.user, "calls.hangup");

  const act = async (path, body, okText) => {
    try { await api(path, { method: "POST", body }); toast(okText); } catch (e) { toast(e.message, "error"); }
  };
  const spy = (call, mode) => {
    const target = call.exts.find((e) => inScope(me.user, "spy", e.peer) && e.peer !== spyFrom) || call.exts[0];
    if (!spyFrom) return toast("داخلی ناظر را انتخاب کنید", "error");
    act("/api/calls/spy", { channel: target.name, mode, from: spyFrom }, `${SPY[mode].label} داخلی ${fa(target.peer)} — ابتدا داخلی ${fa(spyFrom)} زنگ می‌خورد`);
  };
  const totals = { inbound: 0, outbound: 0, internal: 0, ringing: 0 };
  for (const c of calls) { totals[c.direction]++; if (c.status === "ringing") totals.ringing++; }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">تماس‌های آنلاین</h1>
        <span className="chip bg-accent-soft text-accent num">{faNum(calls.length)} تماس</span>
        <span className="text-xs text-ink-3">{faNum(totals.inbound)} ورودی · {faNum(totals.outbound)} خروجی · {faNum(totals.internal)} داخلی · {faNum(totals.ringing)} در حال زنگ</span>
        <div className="flex-1" />
        {canSpy && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-ink-3">داخلی ناظر برای شنود:</span>
            <select className="input w-auto py-1" value={spyFrom} onChange={(e) => setSpyFrom(e.target.value)}>
              <option value="">—</option>
              {dialExts.map((e) => <option key={e.name} value={e.name}>{e.name} {e.callerName}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Icon name="search" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <input className="input pr-9" placeholder="جستجوی شماره، داخلی، نام…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input w-auto" value={dir} onChange={(e) => setDir(e.target.value)}><option value="">همه جهت‌ها</option><option value="inbound">ورودی</option><option value="outbound">خروجی</option><option value="internal">داخلی</option></select>
        <select className="input w-auto" value={state} onChange={(e) => setState(e.target.value)}><option value="">همه وضعیت‌ها</option><option value="talking">در حال مکالمه</option><option value="ringing">در حال زنگ</option><option value="hold">انتظار</option><option value="queued">در صف</option></select>
      </div>

      <div className="card overflow-x-auto">
        {shown.length === 0 ? <Empty icon="phone" title={calls.length ? "تماسی با این فیلتر نیست" : "در حال حاضر تماس فعالی نیست"} /> : (
          <table className="grid-table">
            <thead><tr><th>جهت</th><th>داخلی</th><th>طرف مقابل</th><th>مسیر / ترانک</th><th>وضعیت</th><th>مدت مکالمه</th><th>کل</th><th className="text-left">عملیات</th></tr></thead>
            <tbody>
              {shown.map((c) => {
                const d = DIR[c.direction];
                const st = STATUS[c.status];
                const ext = c.exts[0];
                const other = ext ? otherParty(ext, channels, peers) : { number: c.channels[0].callerNum, name: "" };
                const name = lookup(other.number) || other.name;
                const spyOk = canSpy && c.status === "talking" && callInScope(me.user, "spy", c.exts.map((e) => e.peer)) && c.exts.length > 0 && !c.channels.some((x) => x.app === "ChanSpy");
                return (
                  <tr key={c.id}>
                    <td><span className="flex items-center gap-1.5 text-ink-2"><Icon name={d.icon} className={`size-4 ${c.status === "ringing" ? "shake text-ring" : ""}`} />{d.label}</span></td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {c.exts.map((e) => <span key={e.name} className="chip bg-surface-2"><b className="num">{fa(e.peer)}</b><span className="text-ink-3">{peers[e.peer]?.callerName}</span></span>)}
                        {!c.exts.length && <span className="text-ink-3">—</span>}
                      </div>
                    </td>
                    <td>
                      {c.direction === "internal" && c.exts.length > 1 ? <span className="text-ink-3">بین داخلی‌ها</span> : (
                        <div>
                          <div className="font-medium">{name || (other.number ? <span className="num ltr">{fa(other.number)}</span> : "—")}</div>
                          {name && other.number && <div className="num text-[11px] text-ink-3 ltr text-right">{fa(other.number)}</div>}
                        </div>
                      )}
                    </td>
                    <td className="text-xs text-ink-2 ltr text-right">{c.trunk ? (c.trunk.tech === "DAHDI" ? "E1 / DAHDI" : c.trunk.peer) : "—"}{c.channels.some((x) => x.app === "Queue") ? " · Queue" : ""}</td>
                    <td><span className={`chip bg-${st.color}-soft text-${st.color}`}>{st.label}</span></td>
                    <td className="num font-semibold">{c.answeredAt && c.status !== "queued" ? dur((now - c.answeredAt) / 1000) : "—"}</td>
                    <td className="num text-ink-3">{dur((now - c.startedAt) / 1000)}</td>
                    <td className="whitespace-nowrap text-left">
                      {spyOk && Object.entries(SPY).map(([m, s]) => (
                        <button key={m} className="btn btn-sm ml-1" title={s.hint} onClick={() => spy(c, m)}><Icon name={s.icon} className="size-4" /><span className="hidden xl:inline">{s.label}</span></button>
                      ))}
                      {canHang && <button className="btn btn-sm btn-danger" onClick={() => setConfirm(c)}><Icon name="hangup" className="size-4" /><span className="hidden xl:inline">قطع</span></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {canSpy && <p className="text-xs text-ink-3">در حین شنود با کلید ۴ (شنود)، ۵ (نجوا) و ۶ (ورود به مکالمه) روی گوشی ناظر حالت عوض می‌شود. همه عملیات در «رخدادها» ثبت می‌شود.</p>}

      {confirm && (
        <Modal open title="قطع تماس" onClose={() => setConfirm(null)}
          footer={<><button className="btn" onClick={() => setConfirm(null)}>انصراف</button>
            <button className="btn btn-primary !border-talk !bg-talk" onClick={() => { act("/api/calls/hangup", { channel: (confirm.exts[0] || confirm.channels[0]).name }, "تماس قطع شد"); setConfirm(null); }}>قطع کن</button></>}>
          <p className="text-sm">تماس {confirm.exts.map((e) => fa(e.peer)).join(" و ") || "بدون داخلی"} قطع شود؟ این کار قابل بازگشت نیست.</p>
        </Modal>
      )}
    </div>
  );
}
