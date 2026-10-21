import { useState } from "react";
import { api } from "../api.js";
import { Icon, Spinner, Copyright } from "../components/ui.jsx";

export default function Login({ onLogin }) {
  const [f, setF] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await api("/api/login", { method: "POST", body: f }); onLogin(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7 shadow-sm">
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
      <Copyright />
    </div>
  );
}
