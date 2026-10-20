// Queue monitoring: per-queue KPIs, waiting callers with live wait timers, members with status / pause / today's stats.
import { useMemo, useState } from "react";
import { useLive, useNow } from "../live.js";
import { useSession, can, inScope } from "../session.jsx";
import { otherParty } from "../pbxview.js";
import { api } from "../api.js";
import { fa, faNum, dur, durLong } from "../jalali.js";
import { Icon, Empty, Modal, Field, useToast } from "../components/ui.jsx";
import PhoneIcon from "../components/PhoneIcon.jsx";

const MEMBER = {
  idle: { label: "آزاد", color: "idle" }, inuse: { label: "در مکالمه", color: "talk" }, busy: { label: "مشغول", color: "talk" },
  ringing: { label: "در حال زنگ", color: "ring" }, ringinuse: { label: "زنگ (در مکالمه)", color: "ring" }, hold: { label: "Hold", color: "hold" },
  unavailable: { label: "در دسترس نیست", color: "off" }, invalid: { label: "نامعتبر", color: "off" }, unknown: { label: "نامشخص", color: "off" },
};
const STRATEGY = { ringall: "زنگ همه", leastrecent: "کمترین اخیر", fewestcalls: "کمترین تماس", random: "تصادفی", rrmemory: "نوبتی (با حافظه)", rrordered: "نوبتی مرتب", linear: "خطی", wrandom: "تصادفی وزنی" };

export default function Queues() {
  const { me, lookup } = useSession();
  const toast = useToast();
  const queues = useLive((s) => s.queues);
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const now = useNow();
  const [sel, setSel] = useState("");
  const [pauseFor, setPauseFor] = useState(null);
  const [addTo, setAddTo] = useState(null);
  const manage = can(me.user, "queues.manage");
  const shown = queues.filter((q) => inScope(me.user, "queues", q.name) && (!sel || q.name === sel));

  const act = async (path, body, okText) => {
    try { await api(path, { method: "POST", body }); toast(okText); } catch (e) { toast(e.message, "error"); }
  };
  const totals = useMemo(() => ({
    waiting: queues.reduce((s, q) => s + q.entries.length, 0),
    members: new Set(queues.flatMap((q) => q.members.map((m) => m.interface))).size,
    free: new Set(queues.flatMap((q) => q.members.filter((m) => m.status === "idle" && !m.paused).map((m) => m.interface))).size,
    paused: new Set(queues.flatMap((q) => q.members.filter((m) => m.paused).map((m) => m.interface))).size,
    answered: queues.reduce((s, q) => s + (q.today?.answered || 0), 0),
    abandoned: queues.reduce((s, q) => s + (q.today?.abandoned || 0), 0),
  }), [queues]);

  if (!queues.length) return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">مانیتورینگ صف</h1>
      <div className="card"><Empty icon="users" title="صفی پیدا نشد">صف‌ها با دستور AMI <span className="ltr">QueueStatus</span> خوانده می‌شوند. اگر در ایزابل صف (Queue) تعریف کرده‌اید، دسترسی <span className="ltr">read = agent</span> کاربر AMI را بررسی کنید.</Empty></div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">مانیتورینگ صف</h1>
        <div className="flex-1" />
        <select className="input w-auto" value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">همه صف‌ها</option>
          {queues.map((q) => <option key={q.name} value={q.name}>صف {q.name}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="منتظر در صف‌ها" value={faNum(totals.waiting)} tone={totals.waiting ? "talk" : undefined} />
        <Tile label="اپراتورهای آزاد" value={`${faNum(totals.free)}/${faNum(totals.members)}`} tone="idle" />
        <Tile label="اپراتورهای متوقف" value={faNum(totals.paused)} tone={totals.paused ? "ring" : undefined} />
        <Tile label="پاسخ داده امروز" value={faNum(totals.answered)} />
        <Tile label="رهاشده امروز" value={faNum(totals.abandoned)} tone={totals.abandoned ? "ring" : undefined} />
        <Tile label="نرخ پاسخ امروز" value={totals.answered + totals.abandoned ? fa(`${Math.round((totals.answered / (totals.answered + totals.abandoned)) * 100)}٪`) : "—"} />
      </div>

      {shown.map((q) => {
        const longest = q.entries.length ? Math.max(...q.entries.map((e) => (now - e.joinedAt) / 1000)) : 0;
        const t = q.today || {};
        const answeredAvgWait = t.answered ? t.answeredWait / t.answered : 0;
        return (
          <section key={q.name} className="card">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon name="users" /></div>
              <div>
                <h2 className="text-base font-bold">صف <span className="num">{fa(q.name)}</span></h2>
                <div className="text-xs text-ink-3">استراتژی: {STRATEGY[q.strategy] || q.strategy}{q.max ? ` · ظرفیت ${faNum(q.max)}` : ""} · سطح سرویس {faNum(q.serviceLevel)} ثانیه</div>
              </div>
              <div className="flex-1" />
              <span className={`chip text-sm ${q.entries.length ? "bg-talk-soft text-talk" : "bg-idle-soft text-idle"}`}>{faNum(q.entries.length)} نفر منتظر</span>
              {longest > 0 && <span className="chip bg-ring-soft text-ring">طولانی‌ترین انتظار <span className="num">{dur(longest)}</span></span>}
              {manage && <button className="btn btn-sm" onClick={() => setAddTo(q)}><Icon name="plus" className="size-4" />افزودن اپراتور</button>}
            </div>

            <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 xl:grid-cols-8">
              {[
                ["تماس امروز", faNum(t.offered || 0)], ["پاسخ امروز", faNum(t.answered || 0)], ["رهاشده امروز", faNum(t.abandoned || 0)],
                ["میانگین انتظار امروز", dur(answeredAvgWait)], ["بیشترین انتظار امروز", dur(t.longestWait || 0)],
                ["پاسخ از آخرین reload", faNum(q.completed)], ["رهاشده از reload", faNum(q.abandoned)], ["سطح سرویس (SL)", fa(`${Number(q.serviceLevelPerf || 0).toFixed(1)}٪`)],
              ].map(([k, v]) => <div key={k} className="bg-surface px-4 py-2.5"><div className="text-[11px] text-ink-3">{k}</div><div className="num font-semibold">{v}</div></div>)}
            </div>

            <div className="grid gap-0 xl:grid-cols-[minmax(0,320px)_1fr]">
              <div className="border-b border-line xl:border-b-0 xl:border-l">
                <div className="px-4 py-2.5 text-sm font-semibold">تماس‌گیرندگان منتظر</div>
                {q.entries.length === 0 ? <div className="px-4 pb-4 text-sm text-ink-3">کسی در صف نیست</div> : (
                  <ol className="divide-y divide-line">
                    {q.entries.map((e) => {
                      const w = (now - e.joinedAt) / 1000;
                      return (
                        <li key={e.channel} className="flex items-center gap-3 px-4 py-2">
                          <span className="num flex size-6 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">{fa(e.position)}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{lookup(e.callerNum) || e.callerName || <span className="num ltr">{fa(e.callerNum) || "ناشناس"}</span>}</div>
                            {(lookup(e.callerNum) || e.callerName) && <div className="num text-[11px] text-ink-3">{fa(e.callerNum)}</div>}
                          </div>
                          <span className={`num text-sm font-semibold ${w > q.serviceLevel && q.serviceLevel ? "text-talk" : "text-ring"}`}>{dur(w)}</span>
                          {can(me.user, "calls.hangup") && <button className="rounded-md p-1 text-ink-3 hover:bg-talk-soft hover:text-talk" title="قطع" onClick={() => act("/api/calls/hangup", { channel: e.channel }, "تماس از صف قطع شد")}><Icon name="hangup" className="size-4" /></button>}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="grid-table">
                  <thead><tr><th>اپراتور</th><th>وضعیت</th><th>در تماس با</th><th>پاسخ کل</th><th>امروز (پاسخ / بی‌پاسخ)</th><th>مکالمه امروز</th><th>آخرین تماس</th><th>نوع</th>{manage && <th />}</tr></thead>
                  <tbody>
                    {q.members.map((m) => {
                      const st = MEMBER[m.status] || MEMBER.unknown;
                      const peer = peers[m.ext];
                      const ch = Object.values(channels).find((c) => c.peer === m.ext);
                      const other = ch && otherParty(ch, channels, peers);
                      const md = t.members?.[m.name] || t.members?.[m.interface] || { answered: 0, missed: 0, talk: 0 };
                      return (
                        <tr key={m.interface}>
                          <td>
                            <div className="flex items-center gap-2">
                              <PhoneIcon phone={peer?.phone} status={m.paused ? "offline" : m.status === "idle" ? "idle" : m.status === "ringing" ? "ringing" : m.status === "unavailable" ? "offline" : "talking"} className="size-8" />
                              <div>
                                <div className="font-medium">{m.name}</div>
                                <div className="num text-[11px] text-ink-3 ltr text-right">{m.location}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              <span className={`chip bg-${st.color}-soft text-${st.color}`}>{st.label}</span>
                              {m.paused && <span className="chip bg-ring-soft text-ring" title={m.pausedReason}>متوقف{m.pausedReason ? `: ${m.pausedReason}` : ""}</span>}
                            </div>
                          </td>
                          <td className="text-xs">{other ? <span>{lookup(other.number) || other.name || <span className="num">{fa(other.number)}</span>} <span className="num text-ink-3">{dur((now - (ch.answeredAt || ch.startedAt)) / 1000)}</span></span> : <span className="text-ink-3">—</span>}</td>
                          <td className="num">{faNum(m.callsTaken)}</td>
                          <td className="num">{faNum(md.answered)} / <span className={md.missed ? "text-ring" : ""}>{faNum(md.missed)}</span></td>
                          <td className="num">{md.talk ? durLong(md.talk) : "—"}</td>
                          <td className="text-xs text-ink-3">{m.lastCall ? `${durLong(Math.max(0, now / 1000 - m.lastCall))} پیش` : "—"}</td>
                          <td className="text-xs text-ink-3">{m.membership === "dynamic" ? "پویا" : m.membership === "realtime" ? "Realtime" : "ثابت"}{m.penalty ? ` · P${fa(m.penalty)}` : ""}</td>
                          {manage && (
                            <td className="whitespace-nowrap text-left">
                              {m.paused
                                ? <button className="btn btn-sm" onClick={() => act("/api/queues/pause", { queue: q.name, interface: m.location, paused: false }, `${m.name} فعال شد`)}><Icon name="play" className="size-4" />ادامه</button>
                                : <button className="btn btn-sm" onClick={() => setPauseFor({ q, m })}>توقف</button>}
                              {m.membership === "dynamic" && <button className="btn btn-sm btn-danger mr-1" title="حذف از صف" onClick={() => act("/api/queues/remove", { queue: q.name, interface: m.location }, `${m.name} از صف حذف شد`)}><Icon name="trash" className="size-4" /></button>}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {q.members.length === 0 && <div className="px-4 py-6 text-center text-sm text-ink-3">این صف عضوی ندارد</div>}
              </div>
            </div>
          </section>
        );
      })}
      <p className="text-xs text-ink-3">آمار «امروز» از رویدادهای AMI از زمان روشن شدن پنل جمع می‌شود؛ آمار «از reload» را خود استریسک نگه می‌دارد. اعضای ثابت (static) صف فقط از ایزابل قابل حذف‌اند.</p>

      {pauseFor && <PauseDialog value={pauseFor} onClose={() => setPauseFor(null)} onDone={(reason) => { act("/api/queues/pause", { queue: pauseFor.q.name, interface: pauseFor.m.location, paused: true, reason }, `${pauseFor.m.name} متوقف شد`); setPauseFor(null); }} />}
      {addTo && <AddMember queue={addTo} peers={peers} onClose={() => setAddTo(null)} onAdd={(body) => { act("/api/queues/add", body, "اپراتور به صف اضافه شد"); setAddTo(null); }} />}
    </div>
  );
}

const Tile = ({ label, value, tone }) => (
  <div className="card p-3.5"><div className="text-xs text-ink-3">{label}</div><div className={`num text-xl font-bold ${tone ? `text-${tone}` : ""}`}>{value}</div></div>
);

function PauseDialog({ value, onClose, onDone }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open title={`توقف ${value.m.name} در صف ${fa(value.q.name)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" onClick={() => onDone(reason)}>توقف</button></>}>
      <Field label="دلیل (اختیاری)">
        <input className="input" list="pause-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
        <datalist id="pause-reasons">{["Break", "Lunch", "Meeting", "Training"].map((r) => <option key={r} value={r} />)}</datalist>
      </Field>
      <p className="mt-2 text-xs text-ink-3">دلیل توقف در Asterisk 13 به بعد نمایش داده می‌شود.</p>
    </Modal>
  );
}

function AddMember({ queue, peers, onClose, onAdd }) {
  const exts = Object.values(peers).filter((p) => p.kind === "extension" && !queue.members.some((m) => m.ext === p.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const [ext, setExt] = useState(exts[0]?.name || "");
  const [penalty, setPenalty] = useState("0");
  const p = peers[ext];
  return (
    <Modal open title={`افزودن اپراتور به صف ${fa(queue.name)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" disabled={!ext} onClick={() => onAdd({ queue: queue.name, interface: `${p?.tech || "SIP"}/${ext}`, name: p?.callerName || ext, penalty })}>افزودن</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="داخلی"><select className="input" value={ext} onChange={(e) => setExt(e.target.value)}>{exts.map((e) => <option key={e.name} value={e.name}>{e.name} {e.callerName}</option>)}</select></Field>
        <Field label="Penalty"><input className="input num" value={penalty} onChange={(e) => setPenalty(e.target.value.replace(/\D/g, ""))} /></Field>
      </div>
      <p className="mt-2 text-xs text-ink-3">به‌صورت عضو پویا (dynamic) اضافه می‌شود و با ری‌استارت استریسک ممکن است حذف شود.</p>
    </Modal>
  );
}
