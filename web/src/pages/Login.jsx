import { useEffect, useState } from "react";
import { api } from "../api.js";
import { fa, jOf, MONTHS, weekdayName } from "../jalali.js";
import { Icon, Spinner, Copyright } from "../components/ui.jsx";

/** Server clock: offset from /api/time, ticks locally every second, shown in the server's time zone. */
function useServerClock() {
  const [srv, setSrv] = useState(null); // {offset, tz}
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const sync = () => {
      const sent = Date.now();
      fetch("/api/time").then((r) => r.json()).then((d) => {
        const rtt = Date.now() - sent;
        setSrv({ offset: d.now + rtt / 2 - Date.now(), tz: d.tz });
      }).catch(() => {});
    };
    sync();
    const s = setInterval(sync, 5 * 60000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(s); clearInterval(t); };
  }, []);
  if (!srv) return null;
  const d = new Date(now + srv.offset);
  // wall-clock parts in the server's zone, then our own Jalali formatting (browser fa-IR data varies)
  let parts;
  try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: srv.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value])); }
  catch { parts = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }; }
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const j = jOf(local);
  return {
    time: fa(`${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`),
    jalali: fa(`${weekdayName(local)} ${j.jd} ${MONTHS[j.jm - 1]} ${j.jy}`),
    gregorian: local.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    tz: srv.tz,
  };
}

export default function Login({ onLogin }) {
  const [f, setF] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const clock = useServerClock();
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await api("/api/login", { method: "POST", body: f }); onLogin(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="login-bg relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden p-4">
      <Backdrop />

      <div className="relative z-10 text-center text-white">
        <div className="mb-1 text-xs tracking-wide text-white/60">ساعت سرور</div>
        <div className="num text-5xl font-light leading-tight tracking-wider sm:text-6xl" aria-live="off">{clock?.time || "—:—:—"}</div>
        <div className="mt-2 text-sm text-white/85">{clock?.jalali || " "}</div>
        <div className="mt-0.5 text-xs text-white/55 ltr">{clock ? `${clock.gregorian} · ${clock.tz}` : " "}</div>
      </div>

      <form onSubmit={submit} className="card relative z-10 w-full max-w-sm p-7 shadow-2xl">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-ink"><Icon name="headset" className="size-7" /></div>
          <div>
            <h1 className="text-lg font-bold ltr">MahanAsterisk Monitoring</h1>
            <p className="text-sm text-ink-3">برای ادامه وارد شوید</p>
          </div>
        </div>
        <label className="label" htmlFor="u">نام کاربری</label>
        <input id="u" className="input mb-3 ltr text-left" autoFocus autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <label className="label" htmlFor="p">رمز عبور</label>
        <input id="p" type="password" className="input mb-4 ltr text-left" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        {err && <div className="mb-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
        <button className="btn btn-primary w-full py-2.5" disabled={busy}>{busy ? <Spinner className="size-4" /> : "ورود"}</button>
      </form>
      <Copyright className="relative z-10 !text-white/60" />
    </div>
  );
}

/** Decorative layer: dot grid, glow and voice-wave lines (pure SVG, no images). */
function Backdrop() {
  const waves = [0, 1, 2, 3, 4];
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="login-dots absolute inset-0" />
      <div className="absolute -right-40 -top-40 size-[34rem] rounded-full bg-[#3987e5] opacity-25 blur-3xl" />
      <div className="absolute -bottom-48 -left-32 size-[30rem] rounded-full bg-[#1baf7a] opacity-15 blur-3xl" />
      <svg className="absolute inset-x-0 bottom-0 h-64 w-full" viewBox="0 0 1440 260" preserveAspectRatio="none">
        {waves.map((i) => (
          <path key={i} fill="none" stroke="white" strokeOpacity={0.05 + i * 0.025} strokeWidth="1.5"
            d={`M0 ${150 + i * 14} C 180 ${70 + i * 22}, 360 ${230 - i * 10}, 540 ${150 + i * 6} S 900 ${60 + i * 25}, 1080 ${150 + i * 8} S 1320 ${220 - i * 12}, 1440 ${140 + i * 10}`} />
        ))}
      </svg>
      <svg className="absolute left-[8%] top-[14%] hidden size-40 opacity-[0.07] lg:block" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1">
        <path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
      </svg>
      <svg className="absolute bottom-[18%] right-[9%] hidden size-32 opacity-[0.07] lg:block" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1">
        <path d="M3 14v-2a9 9 0 0 1 18 0v2M3 14a2 2 0 0 1 2-2h1v7H5a2 2 0 0 1-2-2zM21 14a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z" />
      </svg>
    </div>
  );
}
