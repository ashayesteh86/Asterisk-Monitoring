// chan_sip trunk definitions edited over AMI (GetConfig / UpdateConfig).
// Only the panel's own file (default sip_custom.conf) is written; Issabel GUI trunks
// live in sip_additional.conf, which Issabel regenerates, so they are shown read-only.
import { pool } from "./db.js";

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const TRUNK_FIELDS = ["type", "host", "port", "defaultuser", "username", "secret", "fromuser", "fromdomain", "context",
  "insecure", "qualify", "nat", "disallow", "allow", "dtmfmode", "directmedia", "trustrpid", "sendrpid", "call-limit", "transport", "outboundproxy"];

/** GetConfig → [{name, vars:[[key,value]]}] */
export async function getConfig(ami, filename) {
  const r = await ami.action({ Action: "GetConfig", Filename: filename }, 15000);
  if (r.Response !== "Success") throw new Error(r.Message || `خواندن ${filename} ناموفق بود`);
  const cats = new Map();
  for (const [k, v] of Object.entries(r)) {
    const c = /^Category-(\d+)$/.exec(k);
    if (c) cats.set(c[1], { name: v, vars: [] });
  }
  for (const [k, v] of Object.entries(r)) {
    const l = /^Line-(\d+)-(\d+)$/.exec(k);
    if (!l || !cats.has(l[1])) continue;
    for (const line of [].concat(v)) {
      const i = String(line).indexOf("=");
      if (i > 0) cats.get(l[1]).vars[Number(l[2])] = [line.slice(0, i).trim(), line.slice(i + 1).replace(/^>/, "").trim()];
    }
  }
  return [...cats.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, c]) => ({ name: c.name, vars: c.vars.filter(Boolean) }));
}

async function updateConfig(ami, filename, ops, reload = "chan_sip") {
  if (!ops.length) return;
  const action = { Action: "UpdateConfig", SrcFilename: filename, DstFilename: filename, Reload: reload };
  ops.forEach((op, i) => {
    const n = String(i).padStart(6, "0");
    action[`Action-${n}`] = op.action;
    action[`Cat-${n}`] = op.cat;
    if (op.var !== undefined) action[`Var-${n}`] = op.var;
    if (op.value !== undefined) action[`Value-${n}`] = op.value;
    if (op.match !== undefined) action[`Match-${n}`] = op.match;
  });
  const r = await ami.action(action, 20000);
  if (r.Response !== "Success") throw new Error(r.Message || "ذخیره تنظیمات در استریسک ناموفق بود");
}

async function backup(ami, filename, username, note, serverId = null) {
  try {
    const content = await getConfig(ami, filename);
    await pool.query(`INSERT INTO config_backups (filename, content, username, note, server_id) VALUES ($1,$2,$3,$4,$5)`,
      [filename, JSON.stringify(content), username, note, serverId]);
  } catch { /* file may not exist yet */ }
}

export async function listPanelTrunks(ami, file) {
  const cats = await getConfig(ami, file);
  let registers = [];
  try {
    const general = (await getConfig(ami, "sip.conf")).find((c) => c.name === "general");
    registers = (general?.vars || []).filter(([k]) => k === "register").map(([, v]) => v);
  } catch { /* ignore */ }
  return cats.filter((c) => c.name !== "general").map((c) => {
    const fields = Object.fromEntries(c.vars.filter(([k]) => TRUNK_FIELDS.includes(k)));
    const extra = c.vars.filter(([k]) => !TRUNK_FIELDS.includes(k)).map(([k, v]) => `${k}=${v}`).join("\n");
    const register = registers.find((r) => r.endsWith(`/${c.name}`)) || registers.find((r) => fields.host && new RegExp(`@${fields.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:\\d+)?(/|$)`).test(r)) || "";
    return { name: c.name, fields, extra, register };
  });
}

function validate(t) {
  if (!NAME.test(t.name || "")) throw Object.assign(new Error("نام ترانک فقط حروف انگلیسی، عدد و _ . - (شروع با حرف)"), { status: 400 });
  const vars = [];
  for (const k of TRUNK_FIELDS) {
    const v = String(t.fields?.[k] ?? "").trim();
    if (v && /[\r\n]/.test(v)) throw Object.assign(new Error(`مقدار ${k} نامعتبر است`), { status: 400 });
    if (v) vars.push([k, v]);
  }
  for (const line of String(t.extra || "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith(";")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (i <= 0 || !KEY.test(k)) throw Object.assign(new Error(`خط «${line}» در تنظیمات اضافه نامعتبر است`), { status: 400 });
    vars.push([k, line.slice(i + 1).trim()]);
  }
  if (!vars.find(([k]) => k === "type")) vars.unshift(["type", "peer"]);
  if (!vars.find(([k]) => k === "host")) throw Object.assign(new Error("آدرس host ترانک الزامی است"), { status: 400 });
  const register = String(t.register || "").trim();
  if (register && !/^[^\s@]+@[^\s/]+(\/\S+)?$/.test(register)) throw Object.assign(new Error("رشته register باید شبیه user:secret@host/user باشد"), { status: 400 });
  return { vars, register };
}

export async function saveTrunk(ami, file, t, username, originalName, serverId) {
  const { vars, register } = validate(t);
  const existing = await listPanelTrunks(ami, file);
  const oldName = originalName || t.name;
  if (!originalName && existing.some((e) => e.name === t.name)) throw Object.assign(new Error("ترانکی با این نام وجود دارد"), { status: 409 });
  if (originalName && originalName !== t.name && existing.some((e) => e.name === t.name)) throw Object.assign(new Error("ترانکی با این نام وجود دارد"), { status: 409 });
  await backup(ami, file, username, `before save ${t.name}`, serverId);
  const ops = [];
  if (existing.some((e) => e.name === oldName)) ops.push({ action: "DelCat", cat: oldName });
  ops.push({ action: "NewCat", cat: t.name });
  for (const [k, v] of vars) ops.push({ action: "Append", cat: t.name, var: k, value: v });
  await updateConfig(ami, file, ops);
  const prevRegister = existing.find((e) => e.name === oldName)?.register || "";
  if (prevRegister !== register) {
    await backup(ami, "sip.conf", username, `before register change ${t.name}`, serverId);
    const rops = [];
    if (prevRegister) rops.push({ action: "Delete", cat: "general", var: "register", match: prevRegister });
    if (register) rops.push({ action: "Append", cat: "general", var: "register", value: register });
    await updateConfig(ami, "sip.conf", rops);
  }
  await ami.command("sip reload").catch(() => {});
}

export async function deleteTrunk(ami, file, name, username, serverId) {
  const existing = await listPanelTrunks(ami, file);
  const t = existing.find((e) => e.name === name);
  if (!t) throw Object.assign(new Error("این ترانک در فایل پنل نیست (ترانک‌های ساخته‌شده در رابط سرور را از همان‌جا حذف کنید)"), { status: 404 });
  await backup(ami, file, username, `before delete ${name}`, serverId);
  await updateConfig(ami, file, [{ action: "DelCat", cat: name }]);
  if (t.register) await updateConfig(ami, "sip.conf", [{ action: "Delete", cat: "general", var: "register", match: t.register }]);
  await ami.command("sip reload").catch(() => {});
}
