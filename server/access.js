// Access groups: permission flags + per-section extension visibility scopes.
// Scope spec: { mode: "all" | "self" | "list" | "except" | "none", list: "101,105-120,_2XX" }
//   list tokens: exact (101), numeric range (105-120), dialplan pattern (_1XX, _NXXX, _[1-3]XX, _1.).
import { pool } from "./db.js";
import { matchDialplan } from "./util.js";

export const PERMISSIONS = [
  { key: "dashboard.view", label: "داشبورد", group: "مانیتورینگ" },
  { key: "panel.view", label: "پنل اپراتور (داخلی‌ها)", group: "مانیتورینگ" },
  { key: "calls.view", label: "تماس‌های آنلاین", group: "مانیتورینگ" },
  { key: "queues.view", label: "مانیتورینگ صف", group: "مانیتورینگ" },
  { key: "trunks.view", label: "مشاهده ترانک‌ها", group: "مانیتورینگ" },
  { key: "system.view", label: "وضعیت سرور و سرویس‌ها", group: "مانیتورینگ" },
  { key: "calls.hangup", label: "قطع تماس (Hangup)", group: "عملیات تماس" },
  { key: "calls.spy", label: "شنود / نجوا / ورود به مکالمه", group: "عملیات تماس" },
  { key: "calls.transfer", label: "انتقال تماس", group: "عملیات تماس" },
  { key: "dialpad.use", label: "شماره‌گیر و Click-to-Dial", group: "عملیات تماس" },
  { key: "queues.manage", label: "مدیریت اعضای صف (توقف/افزودن/حذف)", group: "عملیات تماس" },
  { key: "phonebook.view", label: "دفترچه تلفن", group: "دفترچه و گزارش" },
  { key: "phonebook.edit_shared", label: "ویرایش مخاطبین اشتراکی دیگران", group: "دفترچه و گزارش" },
  { key: "reports.view", label: "گزارش تماس‌ها", group: "دفترچه و گزارش" },
  { key: "reports.export", label: "خروجی گزارش (CSV)", group: "دفترچه و گزارش" },
  { key: "trunks.manage", label: "ساخت/ویرایش ترانک و reload", group: "مدیریت" },
  { key: "settings.manage", label: "تنظیمات AMI / CDR / سرور", group: "مدیریت" },
  { key: "users.manage", label: "کاربران و گروه‌های دسترسی", group: "مدیریت" },
  { key: "audit.view", label: "مشاهده رخدادها (Audit)", group: "مدیریت" },
];
const PERM_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export const SCOPES = [
  { key: "panel", label: "پنل اپراتور و داشبورد", hint: "داخلی‌هایی که در پنل دیده می‌شوند" },
  { key: "calls", label: "تماس‌های آنلاین", hint: "تماس‌هایی که یکی از این داخلی‌ها در آن است (قطع و انتقال هم محدود به همین‌ها)" },
  { key: "spy", label: "شنود", hint: "تماس کدام داخلی‌ها را می‌تواند شنود کند" },
  { key: "dial", label: "تماس از داخلی", hint: "از کدام داخلی‌ها می‌تواند Click-to-Dial بزند (داخلی خود کاربر همیشه مجاز است)" },
  { key: "reports", label: "گزارش تماس‌ها", hint: "CDR کدام داخلی‌ها را ببیند" },
  { key: "queues", label: "صف‌ها", hint: "نام/شماره صف‌هایی که می‌بیند (مثلاً 400,401)" },
];
const MODES = new Set(["all", "self", "list", "except", "none"]);

export const DEFAULT_GROUPS = [
  { name: "مدیران سیستم", description: "دسترسی کامل", is_admin: true, permissions: PERMISSIONS.map((p) => p.key),
    scopes: Object.fromEntries(SCOPES.map((s) => [s.key, { mode: "all", list: "" }])) },
  { name: "سرپرستان", description: "مانیتورینگ کامل، شنود و قطع تماس", is_admin: false,
    permissions: ["dashboard.view", "panel.view", "calls.view", "queues.view", "trunks.view", "system.view", "calls.hangup", "calls.spy", "calls.transfer", "dialpad.use", "queues.manage", "phonebook.view", "phonebook.edit_shared", "reports.view", "reports.export"],
    scopes: Object.fromEntries(SCOPES.map((s) => [s.key, { mode: "all", list: "" }])) },
  { name: "اپراتورها", description: "پنل، شماره‌گیر و گزارش داخلی خود", is_admin: false,
    permissions: ["dashboard.view", "panel.view", "calls.view", "queues.view", "calls.transfer", "dialpad.use", "phonebook.view", "reports.view"],
    scopes: { panel: { mode: "all", list: "" }, calls: { mode: "self", list: "" }, spy: { mode: "none", list: "" }, dial: { mode: "self", list: "" }, reports: { mode: "self", list: "" }, queues: { mode: "all", list: "" } } },
];

export function cleanGroup(b) {
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) throw Object.assign(new Error("نام گروه الزامی است"), { status: 400 });
  const permissions = [...new Set((Array.isArray(b.permissions) ? b.permissions : []).filter((k) => PERM_KEYS.has(k)))];
  const scopes = {};
  for (const s of SCOPES) {
    const v = b.scopes?.[s.key] || {};
    const mode = MODES.has(v.mode) ? v.mode : "all";
    const list = String(v.list || "").replace(/[^\w,.!\[\]\- ]/g, "").slice(0, 2000);
    if ((mode === "list" || mode === "except") && !list.trim()) throw Object.assign(new Error(`برای «${s.label}» فهرست داخلی‌ها را وارد کنید`), { status: 400 });
    scopes[s.key] = { mode, list };
  }
  const ids = [...new Set((Array.isArray(b.servers?.ids) ? b.servers.ids : []).map(Number).filter((n) => n > 0))];
  const servers = { mode: b.servers?.mode === "list" ? "list" : "all", ids };
  if (servers.mode === "list" && !ids.length && !b.is_admin) throw Object.assign(new Error("حداقل یک سرور برای این گروه انتخاب کنید"), { status: 400 });
  return { name, description: String(b.description || "").slice(0, 200), is_admin: !!b.is_admin, permissions, scopes, servers };
}

function tokenMatch(tok, ext) {
  tok = tok.trim();
  if (!tok) return false;
  const range = /^(\d+)-(\d+)$/.exec(tok);
  if (range) return /^\d+$/.test(ext) && ext.length === range[1].length && Number(ext) >= Number(range[1]) && Number(ext) <= Number(range[2]);
  return matchDialplan(tok, ext);
}

export function listMatch(list, ext) {
  return String(list || "").split(/[,\s]+/).some((t) => tokenMatch(t, String(ext)));
}

/** Does this user's scope for a section include extension (or queue) `ext`? */
export function inScope(user, section, ext) {
  if (!user) return false;
  if (user.isAdmin) return true;
  const s = user.scopes?.[section] || { mode: "all" };
  if (ext === undefined || ext === null || ext === "") return s.mode === "all";
  switch (s.mode) {
    case "all": return true;
    case "self": return !!user.extension && String(ext) === String(user.extension);
    case "list": return listMatch(s.list, ext) || (section === "dial" && String(ext) === String(user.extension));
    case "except": return !listMatch(s.list, ext);
    default: return section === "dial" && !!user.extension && String(ext) === String(user.extension);
  }
}

/** May this user see PBX server `id`? (group setting: all servers, or a list) */
export function serverAllowed(user, id) {
  if (!user) return false;
  if (user.isAdmin || (user.servers?.mode || "all") === "all") return true;
  return (user.servers.ids || []).map(Number).includes(Number(id));
}

export const can = (user, perm) => !!user && (user.isAdmin || user.perms?.includes(perm));

export const requirePerm = (...perms) => (req, res, next) =>
  perms.some((p) => can(req.user, p)) ? next() : res.status(403).json({ error: "دسترسی این بخش برای گروه شما تعریف نشده است" });

/** Create the default groups on first run and attach existing users by their legacy role. */
export async function ensureGroups() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM access_groups`);
  if (rows[0].n > 0) return;
  const ids = [];
  for (const g of DEFAULT_GROUPS) {
    const r = await pool.query(`INSERT INTO access_groups (name, description, is_admin, permissions, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [g.name, g.description, g.is_admin, g.permissions, g.scopes]);
    ids.push(r.rows[0].id);
  }
  await pool.query(`UPDATE users SET group_id = CASE role WHEN 'admin' THEN $1::int WHEN 'supervisor' THEN $2::int ELSE $3::int END WHERE group_id IS NULL`, ids);
}
