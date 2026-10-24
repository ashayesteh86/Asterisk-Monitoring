// Trunk monitoring (status, latency, registration, live calls, E1 channels) and panel-managed chan_sip trunks.
import { useEffect, useMemo, useState } from "react";
import { useLive } from "../live.js";
import { useSession, can } from "../session.jsx";
import { api } from "../api.js";
import { fa, faNum, jFromSql, sqlDate } from "../jalali.js";
import { Icon, Modal, Empty, Field, Spinner, useToast } from "../components/ui.jsx";

const TRUNK_STATUS = {
  online: { label: "متصل", color: "idle" }, unmonitored: { label: "بدون پایش (qualify=no)", color: "idle" },
  lagged: { label: "کند (Lagged)", color: "ring" }, unreachable: { label: "قطع (Unreachable)", color: "talk" }, offline: { label: "نامشخص", color: "off" },
};

const EMPTY = { name: "", fields: { type: "peer", host: "", port: "", defaultuser: "", secret: "", fromuser: "", fromdomain: "", context: "from-trunk", insecure: "port,invite", qualify: "yes", nat: "", disallow: "all", allow: "alaw,ulaw", dtmfmode: "rfc2833", directmedia: "no", "call-limit": "" }, extra: "", register: "" };

export default function Trunks() {
  const peers = useLive((s) => s.peers);
  const channels = useLive((s) => s.channels);
  const registrations = useLive((s) => s.registrations);
  const dahdi = useLive((s) => s.dahdi);
  const { me } = useSession();
  const toast = useToast();
  const admin = can(me.user, "trunks.manage");
  const [config, setConfig] = useState(null);
  const [edit, setEdit] = useState(null);
  const [backups, setBackups] = useState(null);

  const trunks = useMemo(() => Object.values(peers).filter((p) => p.kind === "trunk").sort((a, b) => a.name.localeCompare(b.name)), [peers]);
  const activeBy = useMemo(() => {
    const m = {};
    for (const c of Object.values(channels)) if (c.peer) m[c.peer] = (m[c.peer] || 0) + 1;
    return m;
  }, [channels]);
  const loadConfig = () => admin && api("/api/trunks/config").then(setConfig).catch((e) => setConfig({ error: e.message, trunks: [] }));
  useEffect(() => { loadConfig(); }, []);
  const panelNames = new Set((config?.trunks || []).map((t) => t.name));

  const qualify = async (name) => {
    try { await api(`/api/trunks/${encodeURIComponent(name)}/qualify`, { method: "POST" }); toast(`Qualify برای ${name} ارسال شد`); } catch (e) { toast(e.message, "error"); }
  };
  const reload = async (what) => {
    try { await api("/api/pbx/reload", { method: "POST", body: { what } }); toast("بارگذاری مجدد انجام شد"); } catch (e) { toast(e.message, "error"); }
  };
  const remove = async (name) => {
    if (!confirm(`ترانک ${name} از ${config.file} حذف شود؟ (قبل از حذف نسخه پشتیبان ذخیره می‌شود)`)) return;
    try { await api(`/api/trunks/config/${encodeURIComponent(name)}`, { method: "DELETE" }); toast("حذف شد"); loadConfig(); } catch (e) { toast(e.message, "error"); }
  };
  const regFor = (t) => registrations.find((r) => r.endpoint === t.name || r.host === t.host || r.host === t.ip || (r.username && t.regContact?.includes(r.username)));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">ترانک‌ها و خطوط</h1>
        <div className="flex-1" />
        {admin && (
          <>
            <button className="btn btn-sm" onClick={() => reload("sip")}><Icon name="refresh" className="size-4" />sip reload</button>
            <button className="btn btn-sm" onClick={() => reload("dialplan")}><Icon name="refresh" className="size-4" />dialplan reload</button>
            <button className="btn btn-sm" onClick={() => api("/api/pbx/backups").then(setBackups)}><Icon name="shield" className="size-4" />نسخه‌های پشتیبان</button>
            <button className="btn btn-primary btn-sm" onClick={() => setEdit(structuredClone(EMPTY))}><Icon name="plus" className="size-4" />ترانک جدید</button>
          </>
        )}
      </div>

      <div className="card overflow-x-auto">
        {trunks.length === 0 ? <Empty icon="trunk" title="ترانکی پیدا نشد">ترانک‌ها پیرهایی هستند که نامشان با الگوی داخلی (تنظیمات › شماره‌گیری) مطابقت ندارد.</Empty> : (
          <table className="grid-table">
            <thead><tr><th>نام</th><th>نوع</th><th>آدرس</th><th>وضعیت</th><th>تأخیر</th><th>ثبت (Register)</th><th>تماس فعال</th><th>منبع</th><th /></tr></thead>
            <tbody>
              {trunks.map((t) => {
                const st = TRUNK_STATUS[t.status] || TRUNK_STATUS.offline;
                const reg = regFor(t);
                return (
                  <tr key={t.name}>
                    <td className="font-medium ltr text-right">{t.name}</td>
                    <td className="ltr text-right text-ink-2">{t.tech}</td>
                    <td className="ltr num text-right text-ink-2">{t.ip || t.host || "—"}{t.port && t.ip ? `:${t.port}` : ""}</td>
                    <td><span className={`chip bg-${st.color}-soft text-${st.color}`}><span className={`size-1.5 rounded-full bg-${st.color}`} />{st.label}</span></td>
                    <td className="num">{t.latency != null ? `${fa(t.latency)} ms` : "—"}</td>
                    <td>{reg ? <span className={`chip ${/Registered/i.test(reg.state) ? "bg-idle-soft text-idle" : "bg-ring-soft text-ring"} ltr`}>{reg.state}</span> : <span className="text-ink-3">—</span>}</td>
                    <td className="num font-medium">{faNum(activeBy[t.name] || 0)}</td>
                    <td>{panelNames.has(t.name) ? <span className="chip bg-accent-soft text-accent">پنل</span> : <span className="chip bg-surface-2 text-ink-3" title="ساخته‌شده در رابط یا پیکربندی خود سرور">سرور</span>}</td>
                    <td className="whitespace-nowrap text-left">
                      {can(me.user, "trunks.view") && <button className="btn btn-sm" onClick={() => qualify(t.name)}>Qualify</button>}
                      {admin && panelNames.has(t.name) && <button className="btn btn-sm mr-1" onClick={() => setEdit({ ...structuredClone(config.trunks.find((x) => x.name === t.name)), originalName: t.name })}><Icon name="edit" className="size-4" /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {registrations.length > 0 && (
        <div className="card overflow-x-auto">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">ثبت‌نام‌های خروجی (Outbound Registrations)</div>
          <table className="grid-table">
            <thead><tr><th>فناوری</th><th>سرور</th><th>نام کاربری</th><th>وضعیت</th><th>Refresh</th></tr></thead>
            <tbody>{registrations.map((r, i) => (
              <tr key={i}><td>{r.tech}</td><td className="ltr text-right">{r.host}{r.port ? `:${r.port}` : ""}</td><td className="ltr text-right">{r.username}</td>
                <td><span className={`chip ${/Registered/i.test(r.state) ? "bg-idle-soft text-idle" : "bg-ring-soft text-ring"} ltr`}>{r.state}</span></td><td className="num">{fa(r.refresh || "—")}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {dahdi.length > 0 && (
        <div className="card p-4">
          <div className="mb-3 flex items-center gap-3 text-sm">
            <span className="font-semibold">کانال‌های E1 / DAHDI</span>
            <span className="text-ink-3">{faNum(dahdi.filter((d) => d.active).length)} مشغول از {faNum(dahdi.length)}</span>
            <span className="flex-1" />
            <Legend color="idle" label="آزاد" /><Legend color="talk" label="مشغول" /><Legend color="off" label="آلارم / DND" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5">
            {dahdi.map((d) => {
              const c = d.alarm && d.alarm !== "No Alarm" || d.dnd ? "off" : d.active ? "talk" : "idle";
              return <div key={d.channel} title={`${d.channel} · ${d.signalling} · ${d.alarm}`} className={`num rounded-md py-2 text-center text-xs font-medium bg-${c}-soft text-${c}`}>{fa(d.channel)}</div>;
            })}
          </div>
        </div>
      )}

      {admin && (
        <div className="card">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">ترانک‌های مدیریت‌شده توسط پنل</span>
            <span className="chip bg-surface-2 text-ink-3 ltr">{config?.file || "…"}</span>
          </div>
          <div className="px-4 py-3 text-xs leading-6 text-ink-3">
            این ترانک‌ها با دستور AMI <span className="ltr">UpdateConfig</span> در فایل بالا نوشته می‌شوند (رابط‌های Issabel / FreePBX آن را بازنویسی نمی‌کنند). ترانک‌های ساخته‌شده در رابط مدیریتی سرور (مثل Issabel / FreePBX) در <span className="ltr">sip_additional.conf</span> هستند و اینجا فقط نمایش داده می‌شوند. پیش از هر تغییر، نسخه پشتیبان فایل در دیتابیس پنل ذخیره می‌شود.
          </div>
          {!config ? <div className="p-6 text-center"><Spinner /></div> : config.error ? <div className="px-4 pb-4 text-sm text-talk">{config.error}</div> : (
            <table className="grid-table">
              <thead><tr><th>نام</th><th>Host</th><th>Context</th><th>کدک</th><th>Register</th><th /></tr></thead>
              <tbody>
                {config.trunks.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-ink-3">هنوز ترانکی از پنل ساخته نشده است.</td></tr>}
                {config.trunks.map((t) => (
                  <tr key={t.name}>
                    <td className="font-medium ltr text-right">{t.name}</td>
                    <td className="ltr text-right">{t.fields.host}{t.fields.port ? `:${t.fields.port}` : ""}</td>
                    <td className="ltr text-right">{t.fields.context || "—"}</td>
                    <td className="ltr text-right">{t.fields.allow || "—"}</td>
                    <td className="ltr text-right text-xs">{t.register ? t.register.replace(/:[^@]*@/, ":****@") : "—"}</td>
                    <td className="whitespace-nowrap text-left">
                      <button className="btn btn-sm" onClick={() => setEdit({ ...structuredClone(t), originalName: t.name })}><Icon name="edit" className="size-4" />ویرایش</button>
                      <button className="btn btn-sm btn-danger mr-1" onClick={() => remove(t.name)}><Icon name="trash" className="size-4" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {edit && <TrunkForm value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); loadConfig(); }} />}
      {backups && <Backups list={backups} onClose={() => setBackups(null)} />}
    </div>
  );
}

const Legend = ({ color, label }) => <span className="flex items-center gap-1 text-xs text-ink-3"><span className={`size-2.5 rounded-sm bg-${color}`} />{label}</span>;

function TrunkForm({ value, onClose, onSaved }) {
  const [t, setT] = useState({ ...value, fields: { ...EMPTY.fields, ...value.fields } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  const f = (k) => ({ value: t.fields[k] || "", onChange: (e) => setT({ ...t, fields: { ...t.fields, [k]: e.target.value } }) });
  const save = async () => {
    setBusy(true); setErr("");
    try { await api("/api/trunks/config", { method: "POST", body: t }); toast("ترانک ذخیره و sip reload شد"); onSaved(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const input = "input ltr text-left";
  return (
    <Modal open onClose={onClose} wide title={value.originalName ? `ویرایش ترانک ${value.originalName}` : "ترانک SIP جدید"}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? <Spinner className="size-4" /> : "ذخیره و اعمال"}</button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="نام ترانک (بخش [name])"><input className={input} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="tci-trunk" /></Field>
        <Field label="host"><input className={input} {...f("host")} placeholder="10.0.0.1" /></Field>
        <Field label="port"><input className={input} {...f("port")} placeholder="5060" /></Field>
        <Field label="type"><select className="input" {...f("type")}><option>peer</option><option>friend</option></select></Field>
        <Field label="defaultuser"><input className={input} {...f("defaultuser")} /></Field>
        <Field label="secret"><input className={input} type="password" {...f("secret")} autoComplete="new-password" /></Field>
        <Field label="fromuser"><input className={input} {...f("fromuser")} /></Field>
        <Field label="fromdomain"><input className={input} {...f("fromdomain")} /></Field>
        <Field label="context (ورودی)"><input className={input} {...f("context")} /></Field>
        <Field label="insecure"><input className={input} {...f("insecure")} /></Field>
        <Field label="qualify"><input className={input} {...f("qualify")} /></Field>
        <Field label="nat"><input className={input} {...f("nat")} placeholder="force_rport,comedia" /></Field>
        <Field label="disallow"><input className={input} {...f("disallow")} /></Field>
        <Field label="allow"><input className={input} {...f("allow")} /></Field>
        <Field label="dtmfmode"><input className={input} {...f("dtmfmode")} /></Field>
        <Field label="directmedia"><input className={input} {...f("directmedia")} /></Field>
        <Field label="call-limit"><input className={input} {...f("call-limit")} /></Field>
        <Field label="transport"><input className={input} {...f("transport")} placeholder="udp" /></Field>
      </div>
      <Field className="mt-3" label="تنظیمات اضافه (هر خط key=value)"><textarea className={`${input} h-20 font-mono text-xs`} value={t.extra} onChange={(e) => setT({ ...t, extra: e.target.value })} placeholder="sendrpid=yes" /></Field>
      <Field className="mt-3" label="رشته register (اختیاری — برای ترانک‌های نیازمند ثبت)" hint="مثال: user:password@sip.provider.ir/user — در بخش [general] فایل sip.conf اضافه می‌شود.">
        <input className={input} value={t.register} onChange={(e) => setT({ ...t, register: e.target.value })} />
      </Field>
      {err && <div className="mt-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
    </Modal>
  );
}

function Backups({ list, onClose }) {
  const [view, setView] = useState(null);
  return (
    <Modal open onClose={onClose} wide title="نسخه‌های پشتیبان پیکربندی">
      {list.length === 0 ? <Empty icon="shield" title="هنوز نسخه پشتیبانی ثبت نشده" /> : (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="grid-table">
            <thead><tr><th>زمان</th><th>فایل</th><th>کاربر</th><th>توضیح</th><th /></tr></thead>
            <tbody>{list.map((b) => (
              <tr key={b.id}><td className="num">{jFromSql(sqlDate(new Date(b.at)))}</td><td className="ltr text-right">{b.filename}</td><td>{b.username}</td><td className="ltr text-right text-xs">{b.note}</td>
                <td><button className="btn btn-sm" onClick={() => api(`/api/pbx/backups/${b.id}`).then(setView)}>مشاهده</button></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {view && (
        <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs ltr text-left">
          {(typeof view.content === "string" ? JSON.parse(view.content) : view.content).map((c) => `[${c.name}]\n${c.vars.map(([k, v]) => `${k}=${k === "secret" ? "****" : v}`).join("\n")}`).join("\n\n")}
        </pre>
      )}
    </Modal>
  );
}
