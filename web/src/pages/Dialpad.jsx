// Web dial pad: originate from the user's extension, live state of that extension, recent numbers, phonebook suggestions.
import { useEffect, useMemo, useState } from "react";
import { useLive, useNow } from "../live.js";
import { useSession, useDial, hasRole } from "../session.jsx";
import { buildExtensions, otherParty, STATUS } from "../pbxview.js";
import { api } from "../api.js";
import { fa, toLatinDigits, dur } from "../jalali.js";
import { Icon, useToast } from "../components/ui.jsx";
import PhoneIcon from "../components/PhoneIcon.jsx";

const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];

function loadRecent() { try { return JSON.parse(localStorage.getItem("dial.recent") || "[]"); } catch { return []; } }

export default function Dialpad() {
  const { me, lookup } = useSession();
  const dial = useDial();
  const toast = useToast();
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const now = useNow();
  const [num, setNum] = useState("");
  const [from, setFrom] = useState(me.user.extension || "");
  const [recent, setRecent] = useState(loadRecent);
  const [suggest, setSuggest] = useState([]);
  const exts = useMemo(() => buildExtensions(peers, channels), [peers, channels]);
  const mine = exts.find((e) => e.name === from);
  const canPickFrom = hasRole(me.user, "supervisor");

  useEffect(() => {
    const h = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const k = toLatinDigits(e.key);
      if (/^[0-9*#+]$/.test(k)) setNum((n) => (n + k).slice(0, 32));
      else if (e.key === "Backspace") setNum((n) => n.slice(0, -1));
      else if (e.key === "Enter") call();
      else if (e.key === "Escape") setNum("");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  useEffect(() => {
    if (num.length < 2 && !/\D/.test(num)) { setSuggest([]); return; }
    const t = setTimeout(() => api(`/api/contacts?q=${encodeURIComponent(num)}`).then((r) => setSuggest(r.slice(0, 5))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [num]);

  const call = async (n = num, label) => {
    const number = toLatinDigits(n).replace(/[^\d*#+]/g, "");
    if (!number) return;
    const ok = await dial(number, label || lookup(number) || number, from);
    if (ok) {
      const next = [{ number, label: label || lookup(number) || "", at: Date.now() }, ...recent.filter((r) => r.number !== number)].slice(0, 12);
      setRecent(next);
      try { localStorage.setItem("dial.recent", JSON.stringify(next)); } catch { /* ignore */ }
    }
  };
  const hangup = async () => {
    try { const r = await api("/api/calls/hangup-mine", { method: "POST" }); toast(r.count ? "تماس قطع شد" : "تماسی فعال نبود"); } catch (e) { toast(e.message, "error"); }
  };
  const status = mine ? STATUS[mine.status] : null;
  const call0 = mine?.calls[0];
  const other = call0 && otherParty(call0, channels, peers);

  return (
    <div className="mx-auto grid max-w-4xl gap-5 md:grid-cols-[minmax(0,360px)_1fr]">
      <div className="card p-5">
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-surface-2 p-3">
          <PhoneIcon phone={mine?.phone} status={mine?.status || "offline"} className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink-3">تماس از داخلی</div>
            {canPickFrom ? (
              <select className="input mt-0.5 py-1" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">— انتخاب داخلی —</option>
                {exts.map((e) => <option key={e.name} value={e.name}>{e.name} {e.callerName}</option>)}
              </select>
            ) : <div className="num font-semibold">{fa(from) || "ثبت نشده"} {mine?.callerName}</div>}
          </div>
          {status && <span className={`chip bg-${status.color}-soft text-${status.color}`}>{status.label}</span>}
        </div>

        <div className="relative mb-2 flex h-16 items-center justify-center rounded-xl border border-line px-12">
          <input className="num w-full bg-transparent text-center text-3xl font-light tracking-wider outline-none ltr" value={fa(num)} placeholder="شماره"
            onChange={(e) => setNum(toLatinDigits(e.target.value).replace(/[^\d*#+]/g, "").slice(0, 32))} aria-label="شماره" />
          {num && <button className="absolute left-3 rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" onClick={() => setNum(num.slice(0, -1))} aria-label="پاک کردن"><Icon name="backspace" /></button>}
        </div>
        <div className="mb-3 h-5 text-center text-sm text-accent">{lookup(num)}</div>

        <div className="grid grid-cols-3 gap-2.5 ltr">
          {KEYS.map(([k, sub]) => (
            <button key={k} onClick={() => setNum((n) => (n + k).slice(0, 32))}
              className="flex h-16 flex-col items-center justify-center rounded-2xl bg-surface-2 transition hover:bg-surface-3 active:scale-95">
              <span className="num text-2xl leading-7">{fa(k)}</span>
              <span className="text-[10px] tracking-widest text-ink-3">{sub}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 flex justify-center gap-4">
          <button onClick={() => call()} disabled={!num || !from} aria-label="تماس"
            className="flex size-16 items-center justify-center rounded-full bg-idle text-white shadow-lg transition hover:brightness-110 disabled:opacity-40"><Icon name="phone" className="size-7" /></button>
          {mine?.calls.length > 0 && from === me.user.extension && (
            <button onClick={hangup} aria-label="قطع" className="flex size-16 items-center justify-center rounded-full bg-talk text-white shadow-lg hover:brightness-110"><Icon name="hangup" className="size-7" /></button>
          )}
        </div>
        <p className="mt-4 text-center text-xs leading-5 text-ink-3">پس از زدن تماس، ابتدا تلفن داخلی {fa(from) || "شما"} زنگ می‌خورد؛ با برداشتن گوشی، شماره مقصد گرفته می‌شود. کیبورد هم فعال است (Enter = تماس).</p>
      </div>

      <div className="space-y-4">
        {call0 && (
          <div className={`card border-${status.color} p-4`}>
            <div className="text-xs text-ink-3">تماس جاری داخلی {fa(from)}</div>
            <div className="mt-1 flex items-center gap-3">
              <Icon name={call0.direction === "in" ? "phoneIn" : "phoneOut"} className={`size-6 text-${status.color}`} />
              <div className="flex-1">
                <div className="font-semibold">{lookup(other.number) || other.name || fa(other.number) || status.label}</div>
                {(lookup(other.number) || other.name) && <div className="num text-sm text-ink-3">{fa(other.number)}</div>}
              </div>
              <div className="num text-xl font-semibold">{dur((now - (call0.answeredAt || call0.startedAt)) / 1000)}</div>
            </div>
          </div>
        )}
        {suggest.length > 0 && (
          <div className="card">
            <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">از دفترچه تلفن</div>
            {suggest.map((c) => c.phones.map((p, i) => (
              <button key={`${c.id}-${i}`} onClick={() => call(p.number, c.name)} className="flex w-full items-center gap-3 px-4 py-2.5 text-right hover:bg-surface-2">
                <Icon name="user" className="size-4 text-ink-3" />
                <span className="flex-1">{c.name} <span className="text-xs text-ink-3">{p.label}</span></span>
                <span className="num text-sm ltr">{fa(p.number)}</span>
                <Icon name="phone" className="size-4 text-idle" />
              </button>
            )))}
          </div>
        )}
        <div className="card">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-semibold">شماره‌های اخیر</span>
            {recent.length > 0 && <button className="text-xs text-ink-3 hover:text-talk" onClick={() => { setRecent([]); try { localStorage.removeItem("dial.recent"); } catch { /* ignore */ } }}>پاک کردن</button>}
          </div>
          {recent.length === 0 ? <div className="px-4 py-8 text-center text-sm text-ink-3">هنوز تماسی از اینجا گرفته نشده</div> : recent.map((r) => (
            <button key={r.number} onClick={() => call(r.number, r.label)} className="flex w-full items-center gap-3 px-4 py-2.5 text-right hover:bg-surface-2">
              <Icon name="phoneOut" className="size-4 text-ink-3" />
              <span className="flex-1">{r.label || lookup(r.number) || <span className="num">{fa(r.number)}</span>}</span>
              {(r.label || lookup(r.number)) && <span className="num text-sm text-ink-3 ltr">{fa(r.number)}</span>}
              <Icon name="phone" className="size-4 text-idle" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
