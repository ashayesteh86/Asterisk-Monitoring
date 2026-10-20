// Settings: AMI connection, CDR database, dialing options, users, audit log, own password.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useSession, hasRole } from "../session.jsx";
import { useLive } from "../live.js";
import { fa, jFromSql, sqlDate } from "../jalali.js";
import { Icon, Tabs, Field, Modal, Spinner, useToast } from "../components/ui.jsx";

export default function Settings() {
  const { me } = useSession();
  const admin = hasRole(me.user, "admin");
  const [tab, setTab] = useState(admin ? "ami" : "password");
  const [s, setS] = useState(null);
  const load = () => admin && api("/api/settings").then(setS);
  useEffect(() => { load(); }, []);
  const tabs = admin ? [
    { id: "ami", label: "اتصال AMI", icon: "server" },
    { id: "cdr", label: "دیتابیس CDR", icon: "chart" },
    { id: "dial", label: "شماره‌گیری و شنود", icon: "phone" },
    { id: "users", label: "کاربران", icon: "users" },
    { id: "audit", label: "رخدادها", icon: "shield" },
    { id: "password", label: "رمز عبور من", icon: "user" },
  ] : [{ id: "password", label: "رمز عبور من", icon: "user" }];
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-lg font-bold">تنظیمات</h1>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "password" ? <Password /> : !s ? <div className="p-10 text-center"><Spinner /></div> : (
        <>
          {tab === "ami" && <AmiForm value={s.ami} reload={load} />}
          {tab === "cdr" && <CdrForm value={s.cdr} reload={load} />}
          {tab === "dial" && <DialForm value={s.dial} reload={load} />}
          {tab === "users" && <Users />}
          {tab === "audit" && <Audit />}
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

function CdrForm({ value, reload }) {
  const [v, , bind] = useForm({ ...value, password: "" });
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
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="card space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="آدرس MySQL" className="sm:col-span-2"><input className="input ltr text-left" {...bind("host")} /></Field>
          <Field label="پورت"><input className="input ltr text-left" {...bind("port")} /></Field>
          <Field label="نام کاربری"><input className="input ltr text-left" {...bind("user")} autoComplete="off" /></Field>
          <Field label="رمز" hint={value.passwordSet ? "رمز ذخیره شده است" : ""}><input className="input ltr text-left" type="password" {...bind("password")} autoComplete="new-password" /></Field>
          <Field label="دیتابیس"><input className="input ltr text-left" {...bind("database")} /></Field>
          <Field label="جدول"><input className="input ltr text-left" {...bind("table")} /></Field>
        </div>
        <Result r={r} />
        <div className="flex gap-2">
          <button className="btn" onClick={test} disabled={busy || !v.host}>{busy ? <Spinner className="size-4" /> : <Icon name="pulse" className="size-4" />}تست اتصال</button>
          <button className="btn btn-primary" onClick={save}>ذخیره</button>
        </div>
      </div>
      <div className="card p-4 text-xs leading-6 text-ink-2">
        <div className="mb-1 text-sm font-semibold text-ink">کاربر فقط‌خواندنی روی ایزابل</div>
        روی سرور ایزابل (MariaDB) اجرا کنید:
        <pre className="mt-2 rounded-lg bg-surface-2 p-2.5 ltr text-left text-[11px] leading-5">{`CREATE USER 'panel'@'IP-پنل' IDENTIFIED BY 'رمز';
GRANT SELECT ON asteriskcdrdb.* TO 'panel'@'IP-پنل';
FLUSH PRIVILEGES;`}</pre>
        و در <span className="ltr">/etc/my.cnf</span> مقدار <span className="ltr">bind-address</span> را طوری تنظیم کنید که از سرور پنل در دسترس باشد (پورت ۳۳۰۶ را فقط برای IP پنل در فایروال باز کنید).
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

const ROLES = { admin: "مدیر", supervisor: "سرپرست (شنود، قطع، انتقال)", operator: "اپراتور" };
function Users() {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState(null);
  const toast = useToast();
  const load = () => api("/api/users").then(setList);
  useEffect(() => { load(); }, []);
  const remove = async (u) => {
    if (!confirm(`کاربر ${u.username} حذف شود؟`)) return;
    try { await api(`/api/users/${u.id}`, { method: "DELETE" }); load(); } catch (e) { toast(e.message, "error"); }
  };
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-sm font-semibold">کاربران پنل</span>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ username: "", full_name: "", role: "operator", extension: "", password: "", active: true })}><Icon name="plus" className="size-4" />کاربر جدید</button>
      </div>
      {!list ? <div className="p-8 text-center"><Spinner /></div> : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>نام کاربری</th><th>نام</th><th>نقش</th><th>داخلی</th><th>وضعیت</th><th /></tr></thead>
            <tbody>{list.map((u) => (
              <tr key={u.id}>
                <td className="ltr text-right font-medium">{u.username}</td><td>{u.full_name}</td><td>{ROLES[u.role].split(" ")[0]}</td>
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
      {edit && <UserForm value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </div>
  );
}

function UserForm({ value, onClose, onSaved }) {
  const [v, , bind] = useForm(value);
  const [err, setErr] = useState("");
  const peers = useLive((s) => s.peers);
  const exts = Object.values(peers).filter((p) => p.kind === "extension").sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const save = async () => {
    setErr("");
    try { await api(v.id ? `/api/users/${v.id}` : "/api/users", { method: v.id ? "PUT" : "POST", body: v }); onSaved(); } catch (e) { setErr(e.message); }
  };
  return (
    <Modal open onClose={onClose} title={v.id ? `ویرایش ${v.username}` : "کاربر جدید"}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" onClick={save}>ذخیره</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="نام کاربری"><input className="input ltr text-left" {...bind("username")} disabled={!!v.id} /></Field>
        <Field label="نام کامل"><input className="input" {...bind("full_name")} /></Field>
        <Field label="نقش"><select className="input" {...bind("role")}>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="داخلی"><input className="input num ltr text-left" list="ext-list" {...bind("extension")} /><datalist id="ext-list">{exts.map((e) => <option key={e.name} value={e.name}>{e.callerName}</option>)}</datalist></Field>
        <Field label={v.id ? "رمز جدید (خالی = بدون تغییر)" : "رمز عبور"} className="col-span-2"><input className="input ltr text-left" type="password" {...bind("password")} autoComplete="new-password" /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" {...bind("active", "checkbox")} />حساب فعال است</label>
      {err && <div className="mt-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
    </Modal>
  );
}

const ACTIONS = { login: "ورود", originate: "تماس (Click-to-Dial)", hangup: "قطع تماس", transfer: "انتقال تماس", "spy:listen": "شنود", "spy:whisper": "نجوا", "spy:barge": "ورود به مکالمه",
  "trunk:create": "ایجاد ترانک", "trunk:update": "ویرایش ترانک", "trunk:delete": "حذف ترانک", reload: "بارگذاری مجدد", "settings:ami": "تنظیم AMI", "settings:cdr": "تنظیم CDR",
  "settings:dial": "تنظیم شماره‌گیری", "user:create": "ایجاد کاربر", "user:update": "ویرایش کاربر", "user:delete": "حذف کاربر", "contacts:import": "ورود مخاطبین" };
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
          <option value="">همه</option><option value="spy">فقط شنود</option><option value="originate">تماس‌ها</option><option value="trunk">ترانک‌ها</option><option value="settings">تنظیمات</option><option value="login">ورودها</option>
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
