// Settings: AMI connection, CDR database, dialing options, users, audit log, own password.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useSession, can } from "../session.jsx";
import { listMatch } from "../access.js";
import { useLive } from "../live.js";
import { fa, faNum, jFromSql, sqlDate } from "../jalali.js";
import { Icon, Tabs, Field, Modal, Spinner, useToast } from "../components/ui.jsx";

export default function Settings() {
  const { me } = useSession();
  const sys = can(me.user, "settings.manage");
  const users = can(me.user, "users.manage");
  const tabs = [
    ...(sys ? [{ id: "ami", label: "اتصال AMI", icon: "server" }, { id: "cdr", label: "دیتابیس CDR", icon: "chart" },
      { id: "dial", label: "شماره‌گیری و شنود", icon: "phone" }, { id: "system", label: "مانیتورینگ سرور", icon: "pulse" }] : []),
    ...(users ? [{ id: "groups", label: "گروه‌ها و سطح دسترسی", icon: "shield" }, { id: "users", label: "کاربران", icon: "users" }] : []),
    ...(can(me.user, "audit.view") ? [{ id: "audit", label: "رخدادها", icon: "list" }] : []),
    { id: "password", label: "رمز عبور من", icon: "user" },
  ];
  const [tab, setTab] = useState(tabs[0].id);
  const [s, setS] = useState(null);
  const load = () => sys && api("/api/settings").then(setS);
  useEffect(() => { load(); }, []);
  const needsSettings = ["ami", "cdr", "dial", "system"].includes(tab);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-lg font-bold">{sys || users ? "تنظیمات" : "حساب کاربری"}</h1>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {needsSettings && !s ? <div className="p-10 text-center"><Spinner /></div> : (
        <>
          {tab === "ami" && <AmiForm value={s.ami} reload={load} />}
          {tab === "cdr" && <CdrForm value={s.cdr} sshUser={s.system.sshUser} reload={load} />}
          {tab === "dial" && <DialForm value={s.dial} reload={load} />}
          {tab === "system" && <SystemForm value={s.system} amiHost={s.ami.host} reload={load} />}
          {tab === "groups" && <Groups />}
          {tab === "users" && <Users />}
          {tab === "audit" && <Audit />}
          {tab === "password" && <Password />}
        </>
      )}
    </div>
  );
}

function useForm(initial) {
  const [v, setV] = useState(initial);
  const bind = (k, type) => type === "checkbox"
    ? { checked: !!v[k], onChange: (e) => setV({ ...v, [k]: e.target.checked }) }
    : { value: v[k] ?? "", onChange: (e) => setV({ ...v, [k]: e.target.value }) };
  return [v, setV, bind];
}

function Result({ r }) {
  if (!r) return null;
  return <div className={`rounded-lg px-3 py-2 text-sm ${r.ok ? "bg-idle-soft text-idle" : "bg-talk-soft text-talk"}`}>{r.text}</div>;
}

function AmiForm({ value, reload }) {
  const [v, , bind] = useForm({ ...value, secret: "" });
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const ami = useLive((s) => s.ami);
  const toast = useToast();
  const test = async () => {
    setBusy(true); setR(null);
    const x = await api("/api/settings/ami/test", { method: "POST", body: v }).catch((e) => ({ ok: false, error: e.message }));
    setR({ ok: x.ok, text: x.ok ? `اتصال موفق — Asterisk ${x.version} (${x.banner})` : `ناموفق: ${x.error}` });
    setBusy(false);
  };
  const save = async () => {
    try { await api("/api/settings/ami", { method: "PUT", body: v }); toast("ذخیره شد؛ اتصال AMI از نو برقرار می‌شود"); reload(); } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="card space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="آدرس سرور استریسک" className="sm:col-span-2"><input className="input ltr text-left" {...bind("host")} placeholder="192.168.1.10" /></Field>
          <Field label="پورت"><input className="input ltr text-left" {...bind("port")} /></Field>
          <Field label="نام کاربری AMI"><input className="input ltr text-left" {...bind("username")} autoComplete="off" /></Field>
          <Field label="رمز (secret)" hint={value.secretSet ? "رمز ذخیره شده است؛ برای تغییر، رمز جدید وارد کنید" : ""}><input className="input ltr text-left" type="password" {...bind("secret")} autoComplete="new-password" /></Field>
        </div>
        <Result r={r} />
        <div className="flex gap-2">
          <button className="btn" onClick={test} disabled={busy || !v.host}>{busy ? <Spinner className="size-4" /> : <Icon name="pulse" className="size-4" />}تست اتصال</button>
          <button className="btn btn-primary" onClick={save}>ذخیره و اتصال</button>
        </div>
      </div>
      <div className="space-y-4">
        <div className="card p-4 text-sm">
          <div className="mb-2 font-semibold">وضعیت فعلی</div>
          <div className="flex items-center gap-2"><span className={`size-2 rounded-full ${ami?.status === "connected" ? "bg-idle" : "bg-talk"}`} />{{ connected: "متصل", connecting: "در حال اتصال", error: "خطا", disabled: "تنظیم نشده" }[ami?.status] || "—"}</div>
          {ami?.version && <div className="mt-1 text-ink-3 ltr text-right">Asterisk {ami.version}</div>}
          {ami?.error && <div className="mt-1 text-xs text-talk">{ami.error}</div>}
        </div>
        <div className="card p-4 text-xs leading-6 text-ink-2">
          <div className="mb-1 text-sm font-semibold text-ink">کاربر AMI در ایزابل</div>
          در فایل <span className="ltr">/etc/asterisk/manager_custom.conf</span> اضافه کنید و سپس <span className="ltr">manager reload</span>:
          <pre className="mt-2 rounded-lg bg-surface-2 p-2.5 ltr text-left text-[11px] leading-5">{`[panel]
secret = رمز-قوی
deny = 0.0.0.0/0.0.0.0
permit = IP-سرور-پنل/255.255.255.255
read = system,call,agent,user,config,command,reporting,originate
write = system,call,agent,user,config,command,reporting,originate`}</pre>
        </div>
      </div>
    </div>
  );
}

function CdrForm({ value, sshUser, reload }) {
  const [v, , bind] = useForm({ via: "direct", ...value, password: "" });
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const test = async () => {
    setBusy(true); setR(null);
    const x = await api("/api/settings/cdr/test", { method: "POST", body: v }).catch((e) => ({ ok: false, error: e.message }));
    setR({ ok: x.ok, text: x.ok ? `اتصال موفق — ${fa(Number(x.count).toLocaleString("en-US"))} رکورد، آخرین تماس: ${jFromSql(x.last) || "—"}` : `ناموفق: ${x.error}` });
    setBusy(false);
  };
  const save = async () => {
    try { await api("/api/settings/cdr", { method: "PUT", body: v }); toast("ذخیره شد"); reload(); } catch (e) { toast(e.message, "error"); }
  };
  const ssh = v.via === "ssh";
  const pick = (via) => bind("via").onChange({ target: { value: via } });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="card space-y-4 p-5">
        <div>
          <span className="label">نوع اتصال</span>
          <div className="flex flex-wrap gap-2">
            {[["direct", "مستقیم (پورت ۳۳۰۶)"], ["ssh", "از طریق SSH (بدون باز کردن ۳۳۰۶)"]].map(([k, l]) => (
              <button key={k} type="button" onClick={() => pick(k)} className={`btn btn-sm ${(v.via || "direct") === k ? "!border-accent !bg-accent-soft !text-accent" : ""}`}>{l}</button>
            ))}
          </div>
          {ssh && (
            <p className="mt-2 text-xs leading-5 text-ink-3">
              از همان نام کاربری و رمز SSH تب «مانیتورینگ سرور» استفاده می‌شود
              {sshUser ? <> (کاربر <span className="ltr font-mono">{sshUser}</span>)</> : <b className="text-ring"> — هنوز وارد نشده است</b>}.
              آدرس MySQL را از دید خود سرور ایزابل وارد کنید؛ معمولاً <span className="ltr font-mono">127.0.0.1</span>.
            </p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={ssh ? "آدرس MySQL روی سرور ایزابل" : "آدرس MySQL"} className="sm:col-span-2"><input className="input ltr text-left" {...bind("host")} placeholder={ssh ? "127.0.0.1" : "192.168.1.10"} /></Field>
          <Field label="پورت"><input className="input ltr text-left" {...bind("port")} /></Field>
          <Field label="نام کاربری"><input className="input ltr text-left" {...bind("user")} autoComplete="off" /></Field>
          <Field label="رمز" hint={value.passwordSet ? "رمز ذخیره شده است" : ""}><input className="input ltr text-left" type="password" {...bind("password")} autoComplete="new-password" /></Field>
          <Field label="دیتابیس"><input className="input ltr text-left" {...bind("database")} /></Field>
          <Field label="جدول"><input className="input ltr text-left" {...bind("table")} /></Field>
        </div>
        <Result r={r} />
        <div className="flex gap-2">
          <button className="btn" onClick={test} disabled={busy || (!ssh && !v.host)}>{busy ? <Spinner className="size-4" /> : <Icon name="pulse" className="size-4" />}تست اتصال</button>
          <button className="btn btn-primary" onClick={save}>ذخیره</button>
        </div>
      </div>
      <div className="card p-4 text-xs leading-6 text-ink-2">
        <div className="mb-1 text-sm font-semibold text-ink">کاربر فقط‌خواندنی روی ایزابل</div>
        روی سرور ایزابل (MariaDB) اجرا کنید:
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-2.5 ltr text-left text-[11px] leading-5">{ssh ? `CREATE USER 'panel'@'localhost' IDENTIFIED BY 'PASSWORD';
GRANT SELECT ON asteriskcdrdb.* TO 'panel'@'localhost';
CREATE USER 'panel'@'127.0.0.1' IDENTIFIED BY 'PASSWORD';
GRANT SELECT ON asteriskcdrdb.* TO 'panel'@'127.0.0.1';
FLUSH PRIVILEGES;` : `CREATE USER 'panel'@'PANEL_IP' IDENTIFIED BY 'PASSWORD';
GRANT SELECT ON asteriskcdrdb.* TO 'panel'@'PANEL_IP';
FLUSH PRIVILEGES;`}</pre>
        {ssh
          ? <>در حالت SSH، پورت ۳۳۰۶ بسته می‌ماند و MySQL فقط از خود سرور (localhost) پاسخ می‌دهد. کاربر SSH به دسترسی root نیاز ندارد، ولی <span className="ltr">AllowTcpForwarding</span> در <span className="ltr">sshd_config</span> نباید <span className="ltr">no</span> باشد.</>
          : <>و در <span className="ltr">/etc/my.cnf</span> مقدار <span className="ltr">bind-address</span> را طوری تنظیم کنید که از سرور پنل در دسترس باشد (پورت ۳۳۰۶ را فقط برای IP پنل در فایروال باز کنید).</>}
      </div>
    </div>
  );
}

function DialForm({ value, reload }) {
  const [v, , bind] = useForm(value);
  const toast = useToast();
  const save = async () => {
    try { await api("/api/settings/dial", { method: "PUT", body: v }); toast("ذخیره شد"); reload(); } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="card space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نوع کانال داخلی‌ها برای Originate" hint="Issabel با chan_sip: SIP — اگر داخلی‌ها PJSIP هستند PJSIP. حالت Local از dialplan عبور می‌کند (Follow-Me و …).">
          <select className="input" {...bind("tech")}><option value="SIP">SIP (chan_sip)</option><option value="PJSIP">PJSIP</option><option value="Local">Local (از طریق dialplan)</option></select>
        </Field>
        <Field label="Context شماره‌گیری" hint="در ایزابل معمولاً from-internal"><input className="input ltr text-left" {...bind("context")} /></Field>
        <Field label="الگوی تشخیص داخلی (مثل Dialplan استریسک)" hint="چند الگو را با کاما جدا کنید: _XXX یعنی هر شماره سه‌رقمی، _1XX یعنی ۱۰۰ تا ۱۹۹، _NXXX یعنی ۲۰۰۰ تا ۹۹۹۹، _[1-3]XX، _1. — پیرهایی که با هیچ الگویی مطابقت ندارند ترانک حساب می‌شوند.">
          <input className="input ltr text-left font-mono" {...bind("extensionPattern")} placeholder="_XXX, _XXXX" />
        </Field>
        <Field label="فایل ترانک‌های پنل" hint="باید در sip.conf اینکلود شده باشد (sip_custom.conf در ایزابل)"><input className="input ltr text-left" {...bind("trunkConfigFile")} /></Field>
        <Field label="آدرس فایل‌های ضبط مکالمه (اختیاری)" className="sm:col-span-2"
          hint="مثال: http://pbx.local/monitor/{date}/{recordingfile} — {date} به شکل YYYY/MM/DD و {recordingfile} از ستون CDR جایگزین می‌شود.">
          <input className="input ltr text-left" {...bind("recordingUrl")} />
        </Field>
      </div>
      <div className="space-y-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" {...bind("autoAnswer", "checkbox")} />پاسخ خودکار تلفن اپراتور در Click-to-Dial و شنود (هدر Call-Info / Alert-Info — پشتیبانی Yealink، Grandstream، Snom و …)</label>
        <label className="flex items-center gap-2"><input type="checkbox" {...bind("hideLocal", "checkbox")} />مخفی کردن کانال‌های Local در لیست تماس‌ها</label>
      </div>
      <button className="btn btn-primary" onClick={save}>ذخیره</button>
    </div>
  );
}

// ---------- access groups ----------
const MODES = [
  ["all", "همه"], ["self", "فقط داخلی خود کاربر"], ["list", "فقط این موارد"], ["except", "همه به‌جز این موارد"], ["none", "هیچ‌کدام"],
];

function Groups() {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const toast = useToast();
  const load = () => api("/api/groups").then(setData);
  useEffect(() => { load(); }, []);
  const remove = async (g) => {
    if (!confirm(`گروه «${g.name}» حذف شود؟`)) return;
    try { await api(`/api/groups/${g.id}`, { method: "DELETE" }); toast("گروه حذف شد"); load(); } catch (e) { toast(e.message, "error"); }
  };
  if (!data) return <div className="p-8 text-center"><Spinner /></div>;
  const blank = { name: "", description: "", is_admin: false, permissions: ["dashboard.view", "panel.view"], scopes: Object.fromEntries(data.scopes.map((x) => [x.key, { mode: "all", list: "" }])) };
  return (
    <div className="space-y-4">
      <div className="card p-4 text-sm leading-7 text-ink-2">
        هر کاربر عضو یک <b>گروه دسترسی</b> است. در گروه تعیین می‌کنید کاربر <b>به کدام بخش‌ها و عملیات</b> دسترسی دارد و در هر بخش <b>کدام داخلی‌ها را ببیند</b>.
        فهرست داخلی‌ها مثل Dialplan استریسک نوشته می‌شود: <span className="ltr font-mono">101, 105-120, _2XX, _NXXX</span>.
      </div>
      <div className="card">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-sm font-semibold">گروه‌های دسترسی</span>
          <button className="btn btn-primary btn-sm" onClick={() => setEdit(blank)}><Icon name="plus" className="size-4" />گروه جدید</button>
        </div>
        <div className="divide-y divide-line">
          {data.groups.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className={`flex size-9 items-center justify-center rounded-xl ${g.is_admin ? "bg-talk-soft text-talk" : "bg-accent-soft text-accent"}`}><Icon name="shield" className="size-4" /></div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">{g.name}{g.is_admin && <span className="chip bg-talk-soft text-talk">مدیر کل</span>}</div>
                <div className="truncate text-xs text-ink-3">{g.description || "—"}</div>
              </div>
              <div className="hidden max-w-md flex-wrap gap-1 lg:flex">
                {g.is_admin ? <span className="text-xs text-ink-3">همه دسترسی‌ها و همه داخلی‌ها</span>
                  : data.scopes.map((sc) => { const v = g.scopes?.[sc.key] || { mode: "all" }; return <span key={sc.key} className="chip bg-surface-2 text-[11px] text-ink-2">{sc.label}: {v.mode === "list" || v.mode === "except" ? `${MODES.find((m) => m[0] === v.mode)[1]} (${v.list})` : MODES.find((m) => m[0] === v.mode)?.[1]}</span>; })}
              </div>
              <span className="chip bg-surface-2 text-ink-2">{faNum(g.users)} کاربر</span>
              <span className="chip bg-surface-2 text-ink-2">{g.is_admin ? "همه" : faNum(g.permissions.length)} مجوز</span>
              <button className="btn btn-sm" onClick={() => setEdit(structuredClone(g))}><Icon name="edit" className="size-4" />ویرایش</button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(g)} disabled={g.users > 0} title={g.users ? "ابتدا کاربران را جابه‌جا کنید" : "حذف"}><Icon name="trash" className="size-4" /></button>
            </div>
          ))}
        </div>
      </div>
      {edit && <GroupForm value={edit} meta={data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function GroupForm({ value, meta, onClose, onSaved }) {
  const [g, setG] = useState({ ...value, scopes: { ...Object.fromEntries(meta.scopes.map((x) => [x.key, { mode: "all", list: "" }])), ...value.scopes } });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const peers = useLive((s) => s.peers);
  const queues = useLive((s) => s.queues);
  const exts = Object.values(peers).filter((p) => p.kind === "extension").map((p) => p.name).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const groups = [...new Set(meta.permissions.map((p) => p.group))];
  const togglePerm = (k) => setG({ ...g, permissions: g.permissions.includes(k) ? g.permissions.filter((x) => x !== k) : [...g.permissions, k] });
  const setScope = (k, patch) => setG({ ...g, scopes: { ...g.scopes, [k]: { ...g.scopes[k], ...patch } } });
  const save = async () => {
    setBusy(true); setErr("");
    try { await api(g.id ? `/api/groups/${g.id}` : "/api/groups", { method: g.id ? "PUT" : "POST", body: g }); onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const preview = (key) => {
    const sc = g.scopes[key];
    const pool = key === "queues" ? queues.map((q) => q.name) : exts;
    if (sc.mode === "self") return "فقط داخلی ثبت‌شده برای هر کاربر";
    if (sc.mode === "all") return `همه (${faNum(pool.length)})`;
    if (sc.mode === "none") return key === "dial" ? "فقط داخلی خود کاربر" : "هیچ";
    const hit = pool.filter((e) => (sc.mode === "list" ? listMatch(sc.list, e) : !listMatch(sc.list, e)));
    return hit.length ? `${faNum(hit.length)} مورد: ${hit.slice(0, 14).join("، ")}${hit.length > 14 ? " …" : ""}` : "هیچ موردی از موارد فعلی مطابقت ندارد";
  };
  return (
    <Modal open wide onClose={onClose} title={g.id ? `ویرایش گروه «${value.name}»` : "گروه دسترسی جدید"}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner className="size-4" /> : "ذخیره"}</button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="نام گروه"><input className="input" autoFocus value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} placeholder="مثلاً سرپرست فروش" /></Field>
        <Field label="توضیح"><input className="input" value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <input type="checkbox" checked={g.is_admin} onChange={(e) => setG({ ...g, is_admin: e.target.checked })} />
        <span><b>مدیر کل</b> — همه دسترسی‌ها و همه داخلی‌ها بدون محدودیت</span>
      </label>

      {!g.is_admin && (
        <>
          <h4 className="mb-2 mt-5 text-sm font-semibold">دسترسی به بخش‌ها و عملیات</h4>
          <div className="grid gap-3 md:grid-cols-2">
            {groups.map((grp) => {
              const items = meta.permissions.filter((p) => p.group === grp);
              const all = items.every((p) => g.permissions.includes(p.key));
              return (
                <div key={grp} className="rounded-xl border border-line p-3">
                  <label className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={all} onChange={() => setG({ ...g, permissions: all ? g.permissions.filter((k) => !items.some((p) => p.key === k)) : [...new Set([...g.permissions, ...items.map((p) => p.key)])] })} />
                    {grp}
                  </label>
                  <div className="space-y-1.5 pr-5">
                    {items.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm text-ink-2">
                        <input type="checkbox" checked={g.permissions.includes(p.key)} onChange={() => togglePerm(p.key)} />{p.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <h4 className="mb-1 mt-5 text-sm font-semibold">داخلی‌های قابل مشاهده در هر بخش</h4>
          <p className="mb-3 text-xs text-ink-3">الگوها مثل Dialplan: <span className="ltr font-mono">101</span> (دقیق)، <span className="ltr font-mono">105-120</span> (بازه)، <span className="ltr font-mono">_1XX</span>، <span className="ltr font-mono">_NXXX</span>، <span className="ltr font-mono">_[1-3]XX</span> — با کاما جدا کنید.</p>
          <div className="space-y-2">
            {meta.scopes.map((sc) => {
              const v = g.scopes[sc.key];
              return (
                <div key={sc.key} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-40 flex-1">
                      <div className="text-sm font-medium">{sc.label}</div>
                      <div className="text-[11px] text-ink-3">{sc.hint}</div>
                    </div>
                    <select className="input w-auto" value={v.mode} onChange={(e) => setScope(sc.key, { mode: e.target.value })}>
                      {MODES.filter(([m]) => sc.key !== "queues" || m !== "self").map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                    </select>
                    {(v.mode === "list" || v.mode === "except") && (
                      <input className="input ltr w-full font-mono text-left sm:w-72" value={v.list} onChange={(e) => setScope(sc.key, { list: e.target.value })} placeholder={sc.key === "queues" ? "400, 401" : "101, 110-120, _2XX"} />
                    )}
                  </div>
                  <div className="num mt-1.5 text-[11px] text-accent">{preview(sc.key)}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {err && <div className="mt-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
    </Modal>
  );
}

// ---------- users ----------
function Users() {
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState([]);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState("");
  const toast = useToast();
  const load = () => { api("/api/users").then(setList); api("/api/groups").then((d) => setGroups(d.groups)); };
  useEffect(() => { load(); }, []);
  const remove = async (u) => {
    if (!confirm(`کاربر ${u.username} حذف شود؟`)) return;
    try { await api(`/api/users/${u.id}`, { method: "DELETE" }); load(); } catch (e) { toast(e.message, "error"); }
  };
  const shown = (list || []).filter((u) => !q || `${u.username} ${u.full_name} ${u.extension} ${u.group_name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-sm font-semibold">کاربران پنل</span>
        <div className="flex-1" />
        <input className="input w-56 py-1" placeholder="جستجو…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ username: "", full_name: "", group_id: groups.find((g) => !g.is_admin)?.id || groups[0]?.id, extension: "", password: "", active: true })}><Icon name="plus" className="size-4" />کاربر جدید</button>
      </div>
      {!list ? <div className="p-8 text-center"><Spinner /></div> : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>نام کاربری</th><th>نام</th><th>گروه دسترسی</th><th>داخلی</th><th>وضعیت</th><th /></tr></thead>
            <tbody>{shown.map((u) => (
              <tr key={u.id}>
                <td className="ltr text-right font-medium">{u.username}</td><td>{u.full_name}</td>
                <td>{u.group_name ? <span className="chip bg-accent-soft text-accent">{u.group_name}</span> : <span className="chip bg-talk-soft text-talk">بدون گروه</span>}</td>
                <td className="num">{fa(u.extension) || "—"}</td>
                <td>{u.active ? <span className="chip bg-idle-soft text-idle">فعال</span> : <span className="chip bg-off-soft text-off">غیرفعال</span>}</td>
                <td className="whitespace-nowrap text-left">
                  <button className="btn btn-sm" onClick={() => setEdit({ ...u, password: "" })}><Icon name="edit" className="size-4" /></button>
                  <button className="btn btn-sm btn-danger mr-1" onClick={() => remove(u)}><Icon name="trash" className="size-4" /></button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {edit && <UserForm value={edit} groups={groups} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function UserForm({ value, groups, onClose, onSaved }) {
  const [v, , bind] = useForm(value);
  const [err, setErr] = useState("");
  const peers = useLive((s) => s.peers);
  const exts = Object.values(peers).filter((p) => p.kind === "extension").sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const g = groups.find((x) => String(x.id) === String(v.group_id));
  const save = async () => {
    setErr("");
    try { await api(v.id ? `/api/users/${v.id}` : "/api/users", { method: v.id ? "PUT" : "POST", body: { ...v, group_id: Number(v.group_id) } }); onSaved(); } catch (e) { setErr(e.message); }
  };
  const needsExt = g && !g.is_admin && Object.values(g.scopes || {}).some((s) => s.mode === "self");
  return (
    <Modal open onClose={onClose} title={v.id ? `ویرایش ${v.username}` : "کاربر جدید"}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" onClick={save}>ذخیره</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="نام کاربری"><input className="input ltr text-left" {...bind("username")} disabled={!!v.id} /></Field>
        <Field label="نام کامل"><input className="input" {...bind("full_name")} /></Field>
        <Field label="گروه دسترسی"><select className="input" {...bind("group_id")}>{groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="داخلی کاربر" hint={needsExt && !v.extension ? "این گروه «فقط داخلی خود کاربر» دارد؛ داخلی را وارد کنید" : "برای Click-to-Dial و شنود"}>
          <input className="input num ltr text-left" list="ext-list" {...bind("extension")} />
          <datalist id="ext-list">{exts.map((e) => <option key={e.name} value={e.name}>{e.callerName}</option>)}</datalist>
        </Field>
        <Field label={v.id ? "رمز جدید (خالی = بدون تغییر)" : "رمز عبور"} className="col-span-2"><input className="input ltr text-left" type="password" {...bind("password")} autoComplete="new-password" /></Field>
      </div>
      {g && <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{g.is_admin ? "مدیر کل: همه دسترسی‌ها" : `${faNum(g.permissions.length)} مجوز — ${g.description || ""}`}</div>}
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" {...bind("active", "checkbox")} />حساب فعال است</label>
      {err && <div className="mt-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
    </Modal>
  );
}

// ---------- server monitoring ----------
function SystemForm({ value, amiHost, reload }) {
  const [v, , bind] = useForm({ ...value, sshPassword: "", sshKey: "" });
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const test = async () => {
    setBusy(true); setR(null);
    const x = await api("/api/settings/system/test", { method: "POST", body: v }).catch((e) => ({ ok: false, error: e.message }));
    const m = x.result;
    setR({ ok: x.ok, text: x.ok ? `موفق — CPU ${fa(m.cpu ?? "?")}٪، RAM ${m.memory ? fa(Math.round((m.memory.used / m.memory.total) * 100)) : "?"}٪، ${faNum(m.disks.length)} دیسک، سرویس‌ها: ${m.services.map((x) => `${x.label} ${x.up ? "✓" : "✗"}`).join("، ")}` : `ناموفق: ${x.error}` });
    setBusy(false);
  };
  const save = async () => {
    try { await api("/api/settings/system", { method: "PUT", body: v }); toast("ذخیره شد"); reload(); } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="card space-y-4 p-5">
        <div>
          <span className="label">روش خواندن CPU، RAM، دیسک و سرویس‌ها</span>
          <div className="flex flex-wrap gap-2">
            {[["ami", "از طریق AMI (SHELL)"], ["ssh", "از طریق SSH"], ["off", "خاموش"]].map(([k, l]) => (
              <label key={k} className={`btn btn-sm cursor-pointer ${v.method === k ? "!border-accent !bg-accent-soft !text-accent" : ""}`}>
                <input type="radio" className="hidden" name="m" checked={v.method === k} onChange={() => bind("method").onChange({ target: { value: k } })} />{l}
              </label>
            ))}
          </div>
        </div>
        {v.method === "ssh" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="آدرس سرور" hint={`خالی = ${amiHost || "آدرس AMI"}`} className="sm:col-span-2"><input className="input ltr text-left" {...bind("sshHost")} /></Field>
            <Field label="پورت"><input className="input ltr text-left" {...bind("sshPort")} /></Field>
            <Field label="نام کاربری SSH"><input className="input ltr text-left" {...bind("sshUser")} autoComplete="off" /></Field>
            <Field label="رمز SSH" hint={value.sshPasswordSet ? "ذخیره شده" : ""} className="sm:col-span-2"><input className="input ltr text-left" type="password" {...bind("sshPassword")} autoComplete="new-password" /></Field>
            <Field label="یا کلید خصوصی (OpenSSH)" hint={value.sshKeySet ? "کلید ذخیره شده است" : "به‌جای رمز می‌توانید کلید بدهید"} className="sm:col-span-3"><textarea className="input ltr h-20 text-left font-mono text-xs" {...bind("sshKey")} /></Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="سرویس‌هایی که بررسی شوند" className="sm:col-span-2" hint="نام فرایند؛ برای جایگزین‌ها از | استفاده کنید (mysqld|mariadbd)"><input className="input ltr text-left font-mono" {...bind("services")} /></Field>
          <Field label="فاصله نمونه‌برداری (ثانیه)"><input className="input num" {...bind("interval")} /></Field>
        </div>
        <Result r={r} />
        <div className="flex gap-2">
          <button className="btn" onClick={test} disabled={busy || v.method === "off"}>{busy ? <Spinner className="size-4" /> : <Icon name="pulse" className="size-4" />}تست</button>
          <button className="btn btn-primary" onClick={save}>ذخیره</button>
        </div>
      </div>
      <div className="card p-4 text-xs leading-6 text-ink-2">
        <div className="mb-1 text-sm font-semibold text-ink">کدام روش؟</div>
        <p><b>AMI:</b> بدون نصب چیزی؛ فرمان‌های فقط‌خواندنی (cat /proc، df، pidof) با تابع <span className="ltr">SHELL()</span> اجرا می‌شود. در Asterisk 12 به بعد (Issabel 4) باید در <span className="ltr">/etc/asterisk/asterisk.conf</span> بخش <span className="ltr">[options]</span> این خط باشد و استریسک ری‌استارت شود:</p>
        <pre className="my-2 rounded-lg bg-surface-2 p-2 ltr text-left">live_dangerously = yes</pre>
        <p>این تنظیم به کاربران AMI با مجوز system اجازه اجرای فرمان سیستمی می‌دهد؛ دسترسی AMI را فقط برای IP پنل باز بگذارید.</p>
        <p className="mt-2"><b>SSH:</b> یک کاربر محدود روی سرور ایزابل بسازید (بدون sudo) و رمز یا کلید آن را اینجا وارد کنید.</p>
        <p className="mt-2">RAM و آپتایم استریسک در هر حالت از <span className="ltr">core show sysinfo</span> و <span className="ltr">CoreStatus</span> خوانده می‌شود.</p>
      </div>
    </div>
  );
}

const ACTIONS = { login: "ورود", originate: "تماس (Click-to-Dial)", hangup: "قطع تماس", transfer: "انتقال تماس", "spy:listen": "شنود", "spy:whisper": "نجوا", "spy:barge": "ورود به مکالمه",
  "trunk:create": "ایجاد ترانک", "trunk:update": "ویرایش ترانک", "trunk:delete": "حذف ترانک", reload: "بارگذاری مجدد", "settings:ami": "تنظیم AMI", "settings:cdr": "تنظیم CDR",
  "settings:dial": "تنظیم شماره‌گیری", "settings:system": "تنظیم مانیتورینگ سرور", "group:create": "ایجاد گروه", "group:update": "ویرایش گروه", "group:delete": "حذف گروه",
  "queue:QueuePause": "توقف/ادامه اپراتور صف", "queue:QueueAdd": "افزودن به صف", "queue:QueueRemove": "حذف از صف", "user:create": "ایجاد کاربر", "user:update": "ویرایش کاربر", "user:delete": "حذف کاربر", "contacts:import": "ورود مخاطبین" };
function Audit() {
  const [list, setList] = useState(null);
  const [filter, setFilter] = useState("");
  useEffect(() => { setList(null); api(`/api/audit${filter ? `?action=${filter}` : ""}`).then(setList); }, [filter]);
  return (
    <div className="card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-sm font-semibold">رخدادهای ثبت‌شده</span>
        <div className="flex-1" />
        <select className="input w-auto py-1" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">همه</option><option value="spy">فقط شنود</option><option value="originate">تماس‌ها</option><option value="trunk">ترانک‌ها</option><option value="settings">تنظیمات</option><option value="group">گروه‌ها</option><option value="user">کاربران</option><option value="queue">صف‌ها</option><option value="hangup">قطع تماس</option><option value="login">ورودها</option>
        </select>
      </div>
      {!list ? <div className="p-8 text-center"><Spinner /></div> : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="grid-table">
            <thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>هدف</th><th>جزئیات</th><th>IP</th></tr></thead>
            <tbody>{list.map((a) => (
              <tr key={a.id}>
                <td className="num whitespace-nowrap">{jFromSql(sqlDate(new Date(a.at)))}</td>
                <td>{a.username}</td>
                <td className={a.action.startsWith("spy") ? "font-medium text-hold" : ""}>{ACTIONS[a.action] || a.action}</td>
                <td className="ltr text-right text-xs">{a.target}</td>
                <td className="ltr text-right text-xs text-ink-3">{Object.keys(a.details || {}).length ? JSON.stringify(a.details) : ""}</td>
                <td className="ltr text-right text-xs text-ink-3">{a.ip}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Password() {
  const [v, setV] = useState({ current: "", password: "", confirm: "" });
  const toast = useToast();
  const save = async (e) => {
    e.preventDefault();
    if (v.password !== v.confirm) return toast("تکرار رمز یکسان نیست", "error");
    try { await api("/api/me/password", { method: "PUT", body: v }); toast("رمز عبور تغییر کرد"); setV({ current: "", password: "", confirm: "" }); } catch (x) { toast(x.message, "error"); }
  };
  return (
    <form className="card max-w-md space-y-3 p-5" onSubmit={save}>
      <Field label="رمز فعلی"><input type="password" className="input ltr text-left" value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} autoComplete="current-password" /></Field>
      <Field label="رمز جدید"><input type="password" className="input ltr text-left" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} autoComplete="new-password" /></Field>
      <Field label="تکرار رمز جدید"><input type="password" className="input ltr text-left" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} autoComplete="new-password" /></Field>
      <button className="btn btn-primary">تغییر رمز</button>
    </form>
  );
}
