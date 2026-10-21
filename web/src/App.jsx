import { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { api, setApiServer } from "./api.js";
import { startLive, stopLive, switchLive, useLive } from "./live.js";
import { SessionCtx, useContactsLookup, can } from "./session.jsx";
import { Icon, Spinner, Copyright } from "./components/ui.jsx";
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
import Servers from "./pages/Servers.jsx";

export const NAV = [
  { to: "/servers", icon: "server", label: "همه سرورها", perm: null, el: <Servers />, multi: true },
  { to: "/", icon: "chart", label: "داشبورد", perm: "dashboard.view", el: <Dashboard /> },
  { to: "/panel", icon: "grid", label: "پنل اپراتور", perm: "panel.view", el: <Panel /> },
  { to: "/calls", icon: "phone", label: "تماس‌های آنلاین", perm: "calls.view", el: <Calls /> },
  { to: "/queues", icon: "users", label: "صف‌ها", perm: "queues.view", el: <Queues /> },
  { to: "/trunks", icon: "trunk", label: "ترانک‌ها", perm: "trunks.view", el: <Trunks /> },
  { to: "/system", icon: "pulse", label: "وضعیت سرور", perm: "system.view", el: <SystemPage /> },
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

const SERVER_KEY = "pbx.server";
/** Pick the remembered server if the user may still see it, else the first one. */
function initialServer(list) {
  let saved = 0;
  try { saved = Number(localStorage.getItem(SERVER_KEY)) || 0; } catch { /* ignore */ }
  return (list.find((s) => s.id === saved) || list[0])?.id || 0;
}

export default function App() {
  const [me, setMe] = useState(undefined);
  const [serverId, setServerId] = useState(0);
  const [theme, setTheme] = useTheme();
  const contacts = useContactsLookup(me?.user);
  const load = () => api("/api/me").then((m) => {
    const id = initialServer(m.servers || []);
    setApiServer(id);
    setServerId(id);
    setMe(m);
  }).catch(() => setMe(null));
  useEffect(() => { load(); const h = () => setMe(null); window.addEventListener("auth:logout", h); return () => window.removeEventListener("auth:logout", h); }, []);
  const started = useRef(false);
  useEffect(() => {
    if (me && !started.current) { started.current = true; startLive(serverId); }
    else if (me === null) { started.current = false; stopLive(); }
  }, [me]);
  const liveServers = useLive((st) => st.servers);

  if (me === undefined) return <div className="flex h-screen items-center justify-center text-ink-3"><Spinner /></div>;
  if (!me) return <Login onLogin={load} />;
  const logout = async () => { await api("/api/logout", { method: "POST" }); setMe(null); };

  const servers = liveServers || me.servers || [];
  const server = servers.find((x) => x.id === serverId) || servers[0] || null;
  const selectServer = (id) => {
    if (id === serverId) return;
    try { localStorage.setItem(SERVER_KEY, String(id)); } catch { /* ignore */ }
    setApiServer(id);
    setServerId(id);
    switchLive(id);
  };
  const dial = server?.dial || { tech: "SIP", context: "from-internal", hideLocal: true, recordingUrl: false };
  const nav = NAV.filter((n) => (n.perm ? can(me.user, n.perm) : servers.length > 1 || can(me.user, "settings.manage")));

  return (
    <SessionCtx.Provider value={{ me: { ...me, dial }, reloadMe: load, servers, server, selectServer, ...contacts }}>
      <Shell me={me} nav={nav} servers={servers} server={server} selectServer={selectServer} theme={theme} setTheme={setTheme} logout={logout}>
        {!server ? <NoServer me={me} /> : (
          <Routes key={server.id}>
            {nav.map((n) => <Route key={n.to} path={n.to} element={n.el} />)}
            <Route path="/settings/*" element={<Settings />} />
            <Route path="*" element={<Navigate to={nav.find((n) => !n.multi)?.to || "/settings"} />} />
          </Routes>
        )}
      </Shell>
    </SessionCtx.Provider>
  );
}

function NoServer({ me }) {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <Icon name="server" className="mx-auto size-10 text-ink-3" />
      <div className="mt-3 font-semibold">هیچ سروری برای شما در دسترس نیست</div>
      <p className="mt-1 text-sm text-ink-3">{can(me.user, "settings.manage") ? "از «تنظیمات › سرورها» یک سرور استریسک اضافه کنید." : "از مدیر سیستم بخواهید دسترسی سرور را به گروه شما بدهد."}</p>
      {can(me.user, "settings.manage") && <Routes><Route path="*" element={<Settings />} /></Routes>}
    </div>
  );
}

const STATUS_DOT = { connected: "bg-idle", connecting: "bg-ring", error: "bg-talk", disabled: "bg-off" };

/** Server picker: current server with status; menu lists every allowed server. */
function ServerPicker({ servers, server, selectServer }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  if (!server) return null;
  const st = (s) => (s.enabled ? s.ami?.status : "disabled");
  return (
    <div className="relative px-3 pb-3" ref={box}>
      <button onClick={() => servers.length > 1 && setOpen(!open)} className={`flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2 text-right ${servers.length > 1 ? "hover:border-accent" : "cursor-default"}`}>
        <span className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[st(server)] || "bg-off"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{server.name}</span>
          <span className="block truncate text-[11px] text-ink-3 ltr text-right">{server.ami?.host || "—"}{server.ami?.version ? ` · ${server.ami.version}` : ""}</span>
        </span>
        {servers.length > 1 && <Icon name="chevronL" className={`size-4 shrink-0 text-ink-3 transition ${open ? "-rotate-90" : ""}`} />}
      </button>
      {open && (
        <div className="card absolute inset-x-3 top-full z-50 mt-1 max-h-80 overflow-y-auto p-1 shadow-xl">
          {servers.map((s) => (
            <button key={s.id} onClick={() => { selectServer(s.id); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-right text-sm hover:bg-surface-2 ${s.id === server.id ? "bg-accent-soft text-accent" : ""}`}>
              <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[st(s)] || "bg-off"}`} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-[11px] text-ink-3 ltr">{s.ami?.host}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ me, nav, servers, server, selectServer, theme, setTheme, logout, children }) {
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  const ami = useLive((s) => s.ami);
  const connected = useLive((s) => s.connected);
  const manage = ["settings.manage", "users.manage", "audit.view"].some((p) => can(me.user, p));
  const links = [
    ...nav,
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
        <ServerPicker servers={servers} server={server} selectServer={selectServer} />
        <nav className="flex-1 space-y-0.5 px-3">
          {links.map((l) => [
            <NavLink key={l.to} to={l.to} end={l.to === "/"}
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${isActive ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}>
              <Icon name={l.icon} />{l.label}
            </NavLink>,
            l.multi ? <div key={`${l.to}-sep`} className="mx-3 my-1.5 border-t border-line" /> : null,
          ])}
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
      <main className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur lg:px-6">
          <button className="rounded-lg p-1.5 hover:bg-surface-2 lg:hidden" onClick={() => setMenu(true)} aria-label="منو"><Icon name="menu" /></button>
          <div className="text-sm text-ink-2">{todayLong()}</div>
          {server && servers.length > 1 && <span className="chip hidden bg-accent-soft text-accent sm:inline-flex"><Icon name="server" className="size-3.5" />{server.name}</span>}
          <div className="flex-1" />
          {!amiOk && <span className="chip bg-talk-soft text-talk"><Icon name="alert" className="size-3.5" />{connected ? "AMI متصل نیست" : "در حال اتصال مجدد…"}</span>}
        </header>
        <div className="flex-1 p-4 lg:p-6">{children}</div>
        <Copyright className="border-t border-line px-4 py-4" />
      </main>
    </div>
  );
}
