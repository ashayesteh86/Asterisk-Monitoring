import { useEffect, useState } from "react";
import { NavLink, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import { startLive, stopLive, useLive } from "./live.js";
import { SessionCtx, useContactsLookup, can } from "./session.jsx";
import { Icon, Spinner } from "./components/ui.jsx";
import { todayLong, fa } from "./jalali.js";
import Login from "./pages/Login.jsx";
import Panel from "./pages/Panel.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Calls from "./pages/Calls.jsx";
import Queues from "./pages/Queues.jsx";
import SystemPage from "./pages/System.jsx";
import Trunks from "./pages/Trunks.jsx";
import Phonebook from "./pages/Phonebook.jsx";
import Dialpad from "./pages/Dialpad.jsx";
import Reports from "./pages/Reports.jsx";
import Settings from "./pages/Settings.jsx";

export const NAV = [
  { to: "/", icon: "chart", label: "داشبورد", perm: "dashboard.view", el: <Dashboard /> },
  { to: "/panel", icon: "grid", label: "پنل اپراتور", perm: "panel.view", el: <Panel /> },
  { to: "/calls", icon: "pulse", label: "تماس‌های آنلاین", perm: "calls.view", el: <Calls /> },
  { to: "/queues", icon: "users", label: "صف‌ها", perm: "queues.view", el: <Queues /> },
  { to: "/trunks", icon: "trunk", label: "ترانک‌ها", perm: "trunks.view", el: <Trunks /> },
  { to: "/system", icon: "server", label: "وضعیت سرور", perm: "system.view", el: <SystemPage /> },
  { to: "/phonebook", icon: "book", label: "دفترچه تلفن", perm: "phonebook.view", el: <Phonebook /> },
  { to: "/dialpad", icon: "dialpad", label: "شماره‌گیر", perm: "dialpad.use", el: <Dialpad /> },
  { to: "/reports", icon: "list", label: "گزارش تماس‌ها", perm: "reports.view", el: <Reports /> },
];

function useTheme() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("theme") || "system"; } catch { return "system"; } });
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.dataset.theme = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    apply();
    mq.addEventListener("change", apply);
    try { localStorage.setItem("theme", theme); } catch { /* ignore */ }
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [me, setMe] = useState(undefined);
  const [theme, setTheme] = useTheme();
  const contacts = useContactsLookup(me?.user);
  const load = () => api("/api/me").then(setMe).catch(() => setMe(null));
  useEffect(() => { load(); const h = () => setMe(null); window.addEventListener("auth:logout", h); return () => window.removeEventListener("auth:logout", h); }, []);
  useEffect(() => { if (me) startLive(); else if (me === null) stopLive(); }, [me]);

  if (me === undefined) return <div className="flex h-screen items-center justify-center text-ink-3"><Spinner /></div>;
  if (!me) return <Login onLogin={load} />;
  const logout = async () => { await api("/api/logout", { method: "POST" }); setMe(null); };

  return (
    <SessionCtx.Provider value={{ me, reloadMe: load, ...contacts }}>
      <Shell me={me} theme={theme} setTheme={setTheme} logout={logout}>
        <Routes>
          {NAV.filter((n) => can(me.user, n.perm)).map((n) => <Route key={n.to} path={n.to} element={n.el} />)}
          <Route path="/settings/*" element={<Settings />} />
          <Route path="*" element={<Navigate to={NAV.find((n) => can(me.user, n.perm))?.to || "/settings"} />} />
        </Routes>
      </Shell>
    </SessionCtx.Provider>
  );
}

function Shell({ me, theme, setTheme, logout, children }) {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const ami = useLive((s) => s.ami);
  const connected = useLive((s) => s.connected);
  const manage = ["settings.manage", "users.manage", "audit.view"].some((p) => can(me.user, p));
  const links = [
    ...NAV.filter((n) => can(me.user, n.perm)),
    manage ? { to: "/settings", icon: "settings", label: "تنظیمات" } : { to: "/settings", icon: "user", label: "حساب کاربری" },
  ];
  const amiOk = connected && ami?.status === "connected";
  const nextTheme = { system: "dark", dark: "light", light: "system" }[theme];
  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 right-0 z-40 flex w-60 flex-col border-l border-line bg-surface transition-transform lg:static lg:translate-x-0 ${menu ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-ink"><Icon name="headset" /></div>
          <div>
            <div className="text-sm font-bold leading-5 ltr text-right">MahanAsterisk Monitoring</div>
            <div className="text-xs text-ink-3">Asterisk / Issabel</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === "/"}
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${isActive ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
              <Icon name={l.icon} />{l.label}
            </NavLink>
          ))}
        </nav>
        <div className="m-3 rounded-xl bg-surface-2 p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${amiOk ? "bg-idle" : "bg-talk"}`} />
            <span className="font-medium">{amiOk ? "اتصال AMI برقرار است" : ami?.status === "disabled" ? "AMI تنظیم نشده" : "AMI قطع است"}</span>
          </div>
          <div className="mt-1 text-ink-3 ltr text-right">{amiOk ? `Asterisk ${ami.version} — ${ami.host}` : ami?.error || (connected ? "" : "اتصال به سرور پنل قطع است")}</div>
        </div>
        <div className="flex items-center gap-2 border-t border-line p-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-surface-3 text-ink-2"><Icon name="user" className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{me.user.full_name || me.user.username}</div>
            <div className="truncate text-xs text-ink-3">{me.user.group_name || "بدون گروه"}{me.user.extension ? ` · داخلی ${fa(me.user.extension)}` : ""}</div>
          </div>
          <button className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" onClick={() => setTheme(nextTheme)} title={`پوسته: ${{ system: "خودکار", dark: "تیره", light: "روشن" }[theme]}`}>
            <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "pulse"} className="size-4" />
          </button>
          <button className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-2" onClick={logout} title="خروج"><Icon name="logout" className="size-4" /></button>
        </div>
      </aside>
      {menu && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMenu(false)} />}
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur lg:px-6">
          <button className="rounded-lg p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setMenu(true)} aria-label="منو"><Icon name="menu" /></button>
          <div className="text-sm text-ink-2">{todayLong()}</div>
          <div className="flex-1" />
          {!amiOk && <span className="chip bg-talk-soft text-talk"><Icon name="alert" className="size-3.5" />{connected ? "AMI متصل نیست" : "در حال اتصال مجدد…"}</span>}
        </header>
        <div className="p-4 lg:p-6">{children}</div>
      </main>
    </div>
  );
}
