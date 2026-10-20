// Shared / personal phonebook with click-to-dial, groups, favourites and CSV import/export.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useSession, useDial, can } from "../session.jsx";
import { fa, faNum } from "../jalali.js";
import { Icon, Modal, Empty, Field, Spinner, useToast } from "../components/ui.jsx";

const LABELS = ["موبایل", "محل کار", "منزل", "فکس", "سایر"];
const BLANK = { name: "", company: "", title: "", phones: [{ label: "موبایل", number: "" }], email: "", group_name: "", notes: "", favorite: false, shared: true };

export default function Phonebook() {
  const { me, reload: reloadLookup } = useSession();
  const dial = useDial();
  const toast = useToast();
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [fav, setFav] = useState(false);
  const [edit, setEdit] = useState(null);
  const file = useRef(null);

  const load = () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (group) p.set("group", group);
    if (fav) p.set("favorite", "1");
    api(`/api/contacts?${p}`).then(setList).catch((e) => toast(e.message, "error"));
    api("/api/contacts/groups").then(setGroups).catch(() => {});
  };
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [q, group, fav]);

  const changed = () => { load(); reloadLookup(); };
  const remove = async (c) => {
    if (!confirm(`«${c.name}» حذف شود؟`)) return;
    try { await api(`/api/contacts/${c.id}`, { method: "DELETE" }); changed(); } catch (e) { toast(e.message, "error"); }
  };
  const toggleFav = async (c) => {
    try { await api(`/api/contacts/${c.id}`, { method: "PUT", body: { ...c, favorite: !c.favorite } }); changed(); } catch (e) { toast(e.message, "error"); }
  };
  const importCsv = async (f) => {
    if (!f) return;
    try {
      const r = await api("/api/contacts/import", { method: "POST", body: await f.text() });
      toast(`${faNum(r.added)} مخاطب اضافه شد${r.skipped ? ` — ${faNum(r.skipped)} ردیف نامعتبر رد شد` : ""}`);
      changed();
    } catch (e) { toast(e.message, "error"); }
    file.current.value = "";
  };
  const canEdit = (c) => c.owner_id === me.user.id || can(me.user, "phonebook.edit_shared");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-bold">دفترچه تلفن</h1>
        <div className="flex-1" />
        <a className="btn btn-sm" href="/api/contacts/export.csv"><Icon name="download" className="size-4" />خروجی CSV</a>
        <button className="btn btn-sm" onClick={() => file.current.click()}><Icon name="upload" className="size-4" />ورود از CSV</button>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => importCsv(e.target.files[0])} />
        <button className="btn btn-primary btn-sm" onClick={() => setEdit(structuredClone(BLANK))}><Icon name="plus" className="size-4" />مخاطب جدید</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Icon name="search" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <input className="input pr-9" placeholder="جستجوی نام، شرکت، شماره…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input w-auto" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">همه گروه‌ها</option>
          {groups.map((g) => <option key={g.group_name} value={g.group_name}>{g.group_name} ({fa(g.n)})</option>)}
        </select>
        <button className={`btn btn-sm ${fav ? "!border-ring !bg-ring-soft !text-ring" : ""}`} onClick={() => setFav(!fav)}><Icon name="star" className="size-4" />علاقه‌مندی‌ها</button>
      </div>

      <div className="card overflow-x-auto">
        {!list ? <div className="p-10 text-center"><Spinner /></div> : list.length === 0 ? (
          <Empty icon="book" title="مخاطبی پیدا نشد">مخاطب جدید اضافه کنید یا فایل CSV با ستون‌های name, company, mobile, work, home, email, group وارد کنید.</Empty>
        ) : (
          <table className="grid-table">
            <thead><tr><th className="w-8" /><th>نام</th><th>شرکت / سمت</th><th>شماره‌ها (کلیک = تماس)</th><th>گروه</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td><button onClick={() => toggleFav(c)} aria-label="علاقه‌مندی" className={c.favorite ? "text-ring" : "text-ink-3 opacity-40 hover:opacity-100"}><Icon name="star" className="size-4" /></button></td>
                  <td>
                    <div className="font-medium">{c.name}</div>
                    {!c.shared && <span className="text-[11px] text-ink-3">شخصی</span>}
                  </td>
                  <td className="text-ink-2">{[c.company, c.title].filter(Boolean).join(" · ") || "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {c.phones.map((p, i) => (
                        <button key={i} onClick={() => can(me.user, "dialpad.use") && dial(p.number, c.name)} title={`تماس از داخلی ${me.user.extension || "—"}`}
                          className="group flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs hover:border-idle hover:bg-idle-soft">
                          <Icon name="phone" className="size-3.5 text-idle" />
                          <span className="num ltr">{fa(p.number)}</span>
                          <span className="text-ink-3">{p.label}</span>
                        </button>
                      ))}
                    </div>
                  </td>
                  <td>{c.group_name ? <span className="chip bg-surface-2 text-ink-2">{c.group_name}</span> : ""}</td>
                  <td className="whitespace-nowrap text-left">
                    {canEdit(c) && <>
                      <button className="btn btn-sm" onClick={() => setEdit(structuredClone(c))} aria-label="ویرایش"><Icon name="edit" className="size-4" /></button>
                      <button className="btn btn-sm btn-danger mr-1" onClick={() => remove(c)} aria-label="حذف"><Icon name="trash" className="size-4" /></button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!me.user.extension && <p className="text-xs text-ring">برای استفاده از Click-to-Dial، مدیر باید داخلی شما را در تنظیمات کاربران ثبت کند.</p>}
      {edit && <ContactForm value={edit} groups={groups} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); changed(); }} />}
    </div>
  );
}

function ContactForm({ value, groups, onClose, onSaved }) {
  const [c, setC] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setC({ ...c, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setPhone = (i, k, v) => setC({ ...c, phones: c.phones.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api(c.id ? `/api/contacts/${c.id}` : "/api/contacts", { method: c.id ? "PUT" : "POST", body: c });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={c.id ? "ویرایش مخاطب" : "مخاطب جدید"}
      footer={<><button className="btn" onClick={onClose}>انصراف</button><button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner className="size-4" /> : "ذخیره"}</button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="نام و نام خانوادگی" className="col-span-2"><input className="input" autoFocus value={c.name} onChange={set("name")} /></Field>
        <Field label="شرکت / سازمان"><input className="input" value={c.company} onChange={set("company")} /></Field>
        <Field label="سمت"><input className="input" value={c.title} onChange={set("title")} /></Field>
      </div>
      <div className="mt-4 space-y-2">
        <span className="label">شماره‌ها</span>
        {c.phones.map((p, i) => (
          <div key={i} className="flex gap-2">
            <select className="input w-32" value={p.label} onChange={(e) => setPhone(i, "label", e.target.value)}>{LABELS.map((l) => <option key={l}>{l}</option>)}</select>
            <input className="input num ltr flex-1 text-left" placeholder="09121234567" value={p.number} onChange={(e) => setPhone(i, "number", e.target.value)} />
            {c.phones.length > 1 && <button className="btn btn-sm btn-danger" onClick={() => setC({ ...c, phones: c.phones.filter((_, j) => j !== i) })} aria-label="حذف شماره"><Icon name="x" className="size-4" /></button>}
          </div>
        ))}
        <button className="btn btn-sm" onClick={() => setC({ ...c, phones: [...c.phones, { label: "محل کار", number: "" }] })}><Icon name="plus" className="size-4" />شماره دیگر</button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="ایمیل"><input className="input ltr text-left" value={c.email} onChange={set("email")} /></Field>
        <Field label="گروه">
          <input className="input" list="pb-groups" value={c.group_name} onChange={set("group_name")} placeholder="مشتریان، تأمین‌کنندگان…" />
          <datalist id="pb-groups">{groups.map((g) => <option key={g.group_name} value={g.group_name} />)}</datalist>
        </Field>
        <Field label="یادداشت" className="col-span-2"><textarea className="input h-16" value={c.notes} onChange={set("notes")} /></Field>
      </div>
      <div className="mt-3 flex gap-5 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.shared} onChange={set("shared")} />اشتراکی (برای همه کاربران)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.favorite} onChange={set("favorite")} />علاقه‌مندی</label>
      </div>
      {err && <div className="mt-3 rounded-lg bg-talk-soft px-3 py-2 text-sm text-talk">{err}</div>}
    </Modal>
  );
}
