// HTTP API + WebSocket live feed for the Asterisk operator panel.
import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { pool, migrate, loadSettings, settings, saveSettings, publicSettings, audit } from "./db.js";
import { hashPassword, verifyPassword, setSessionCookie, clearSessionCookie, requireAuth, userFromRequest, ensureAdmin, forgetUser } from "./auth.js";
import { PERMISSIONS, SCOPES, cleanGroup, inScope, can, requirePerm, ensureGroups } from "./access.js";
import { QueueMonitor } from "./ami/queues.js";
import { SystemMonitor, sshExec, metricsScript, parseMetrics } from "./system.js";
import { startSampler, series, peaks } from "./samples.js";
import { AmiClient, testAmi } from "./ami/client.js";
import { Pbx } from "./ami/pbx.js";
import { listCdr, cdrStats, exportCdr, testCdr, resetCdrPool } from "./cdr.js";
import { listPanelTrunks, saveTrunk, deleteTrunk, getConfig } from "./trunks.js";
import { normalizeNumber, parseCsv, toCsv, checkDialplanList } from "./util.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const k of ["DATABASE_URL", "APP_SECRET"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }

await migrate();
await loadSettings();
await ensureAdmin();
await ensureGroups();

const ami = new AmiClient();
const pbx = new Pbx(ami, () => settings().dial);
const queues = new QueueMonitor(ami);
const system = new SystemMonitor(ami);
ami.configure(settings().ami);
startSampler(pbx, queues);

// ---------- visibility ----------
/** channel name → extensions taking part in that call */
function callIndex() {
  const idx = new Map();
  for (const c of pbx.calls()) for (const ch of c.channels) idx.set(ch.name, c.exts);
  return idx;
}
const callExts = (name, idx = callIndex()) => idx.get(name) || [];
/** Is the call that `channel` belongs to inside the user's scope for `section`? */
function callInScope(user, section, channel, idx) {
  if (user.isAdmin) return true;
  const exts = callExts(channel, idx);
  return exts.length ? exts.some((e) => inScope(user, section, e)) : inScope(user, section, "");
}
const LIVE_SECTIONS = ["panel", "calls", "spy", "dial"];
const peerVisible = (user, p) => p.kind !== "extension" || LIVE_SECTIONS.some((s) => inScope(user, s, p.name));
const channelVisible = (user, ch, idx) => user.isAdmin || ["panel", "calls"].some((s) => callInScope(user, s, ch.name, idx));
const queueView = (user, list) => (can(user, "queues.view") ? list.filter((q) => inScope(user, "queues", q.name)) : []);
function peerView(user, p) {
  if (p.kind === "extension" || can(user, "trunks.view")) return p;
  return { name: p.name, kind: p.kind, tech: p.tech, status: p.status, phone: p.phone, callerName: "", ip: "", userAgent: "", latency: null };
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: "text/csv", limit: "10mb" }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DIAL_NUMBER = /^[0-9*#+]{1,32}$/;
const EXT = /^[A-Za-z0-9_.-]{1,40}$/;

app.get("/healthz", (req, res) => res.json({ ok: true, ami: ami.status }));

// ---------- auth ----------
const loginAttempts = new Map();
app.post("/api/login", wrap(async (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - a.at > 15 * 60000) { a.n = 0; a.at = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: "تلاش‌های ناموفق زیاد؛ ۱۵ دقیقه بعد دوباره امتحان کنید" });
  const { username, password } = req.body || {};
  const { rows } = await pool.query(`SELECT * FROM users WHERE lower(username) = lower($1) AND active`, [String(username || "")]);
  if (!rows[0] || !verifyPassword(password, rows[0].password_hash)) {
    a.n++; loginAttempts.set(ip, a);
    return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
  }
  loginAttempts.delete(ip);
  setSessionCookie(req, res, rows[0]);
  req.user = rows[0];
  await audit(req, "login");
  res.json({ ok: true });
}));

app.post("/api/logout", (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

app.use("/api", requireAuth);

app.get("/api/me", (req, res) => {
  const d = settings().dial;
  res.json({ user: req.user, permissions: PERMISSIONS, scopes: SCOPES,
    dial: { tech: d.tech, context: d.context, hideLocal: d.hideLocal, extensionPattern: d.extensionPattern, recordingUrl: !!d.recordingUrl } });
});

app.put("/api/me/password", wrap(async (req, res) => {
  const { current, password } = req.body || {};
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!verifyPassword(current, rows[0].password_hash)) return res.status(400).json({ error: "رمز فعلی اشتباه است" });
  if (String(password || "").length < 6) return res.status(400).json({ error: "رمز جدید حداقل ۶ کاراکتر" });
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hashPassword(password), req.user.id]);
  res.json({ ok: true });
}));

// ---------- live state ----------
app.get("/api/state", (req, res) => res.json(snapshotFor(req.user)));

// ---------- calls: originate / hangup / transfer / spy ----------
function originateChannel(ext) {
  const d = settings().dial;
  return d.tech === "Local" ? `Local/${ext}@${d.context}` : `${d.tech}/${ext}`;
}

function autoAnswerVars() {
  if (!settings().dial.autoAnswer) return [];
  return ["SIPADDHEADER01=Call-Info:<uri>\\;answer-after=0", "SIPADDHEADER02=Alert-Info:info=alert-autoanswer"];
}

app.post("/api/calls/originate", requirePerm("dialpad.use"), wrap(async (req, res) => {
  const number = String(req.body?.number || "").replace(/[\s\-()]/g, "");
  const from = String(req.body?.from || req.user.extension || "");
  if (!DIAL_NUMBER.test(number)) return res.status(400).json({ error: "شماره نامعتبر است" });
  if (!EXT.test(from)) return res.status(400).json({ error: "داخلی مبدأ مشخص نیست؛ در پروفایل کاربر داخلی را تنظیم کنید" });
  if (from !== req.user.extension && !inScope(req.user, "dial", from)) return res.status(403).json({ error: `اجازه تماس از داخلی ${from} را ندارید` });
  const d = settings().dial;
  const r = await ami.action({
    Action: "Originate", Channel: originateChannel(from), Context: d.context, Exten: number, Priority: 1,
    CallerID: `"${String(req.body?.label || number).replace(/["<>]/g, "").slice(0, 30)}" <${number}>`,
    Timeout: 30000, Async: "true", Variable: autoAnswerVars(),
  });
  if (r.Response !== "Success") return res.status(502).json({ error: r.Message || "برقراری تماس ناموفق بود" });
  await audit(req, "originate", number, { from });
  res.json({ ok: true });
}));

app.post("/api/calls/hangup", requirePerm("calls.hangup"), wrap(async (req, res) => {
  const channel = String(req.body?.channel || "");
  if (!pbx.channels.has(channel)) return res.status(404).json({ error: "این تماس دیگر فعال نیست" });
  if (!callInScope(req.user, "calls", channel)) return res.status(403).json({ error: "این تماس در محدوده دسترسی شما نیست" });
  const r = await ami.action({ Action: "Hangup", Channel: channel });
  if (r.Response !== "Success") return res.status(502).json({ error: r.Message });
  await audit(req, "hangup", channel);
  res.json({ ok: true });
}));

app.post("/api/calls/hangup-mine", requirePerm("dialpad.use"), wrap(async (req, res) => {
  const mine = [...pbx.channels.values()].filter((c) => c.peer && c.peer === req.user.extension);
  for (const c of mine) await ami.action({ Action: "Hangup", Channel: c.name }).catch(() => {});
  res.json({ ok: true, count: mine.length });
}));

app.post("/api/calls/transfer", requirePerm("calls.transfer"), wrap(async (req, res) => {
  const channel = String(req.body?.channel || "");
  const target = String(req.body?.target || "");
  const ch = pbx.channels.get(channel);
  if (!ch) return res.status(404).json({ error: "این تماس دیگر فعال نیست" });
  if (!DIAL_NUMBER.test(target)) return res.status(400).json({ error: "مقصد انتقال نامعتبر است" });
  if (!callInScope(req.user, "calls", channel)) return res.status(403).json({ error: "این تماس در محدوده دسترسی شما نیست" });
  const r = await ami.action({ Action: "Redirect", Channel: channel, Context: settings().dial.context, Exten: target, Priority: 1 });
  if (r.Response !== "Success") return res.status(502).json({ error: r.Message || "انتقال ناموفق بود" });
  await audit(req, "transfer", channel, { target });
  res.json({ ok: true });
}));

const SPY_MODES = { listen: "qEd", whisper: "qEdw", barge: "qEdB" };
app.post("/api/calls/spy", requirePerm("calls.spy"), wrap(async (req, res) => {
  const channel = String(req.body?.channel || "");
  const mode = SPY_MODES[req.body?.mode] ? req.body.mode : "listen";
  const from = String(req.body?.from || req.user.extension || "");
  const ch = pbx.channels.get(channel);
  if (!ch) return res.status(404).json({ error: "این تماس دیگر فعال نیست" });
  if (!EXT.test(from)) return res.status(400).json({ error: "داخلی ناظر مشخص نیست" });
  if (ch.peer === from) return res.status(400).json({ error: "نمی‌توانید تماس داخلی خودتان را شنود کنید" });
  if (!callInScope(req.user, "spy", channel)) return res.status(403).json({ error: "شنود این داخلی برای گروه شما مجاز نیست" });
  if (from !== req.user.extension && !inScope(req.user, "dial", from)) return res.status(403).json({ error: `اجازه استفاده از داخلی ${from} را ندارید` });
  const r = await ami.action({
    Action: "Originate", Channel: originateChannel(from), Application: "ChanSpy",
    Data: `${channel},${SPY_MODES[mode]}`, CallerID: `"Spy ${ch.peer}" <${ch.peer}>`, Timeout: 30000, Async: "true",
    Variable: autoAnswerVars(),
  });
  if (r.Response !== "Success") return res.status(502).json({ error: r.Message || "شنود ناموفق بود" });
  await audit(req, `spy:${mode}`, channel, { from, peer: ch.peer });
  res.json({ ok: true });
}));

// ---------- trunks ----------
app.get("/api/trunks/config", requirePerm("trunks.manage"), wrap(async (req, res) => {
  res.json({ file: settings().dial.trunkConfigFile, trunks: await listPanelTrunks(ami) });
}));
app.post("/api/trunks/config", requirePerm("trunks.manage"), wrap(async (req, res) => {
  await saveTrunk(ami, req.body, req.user.username, req.body.originalName);
  await audit(req, req.body.originalName ? "trunk:update" : "trunk:create", req.body.name);
  res.json({ ok: true });
}));
app.delete("/api/trunks/config/:name", requirePerm("trunks.manage"), wrap(async (req, res) => {
  await deleteTrunk(ami, req.params.name, req.user.username);
  await audit(req, "trunk:delete", req.params.name);
  res.json({ ok: true });
}));
app.post("/api/trunks/:name/qualify", requirePerm("trunks.view"), wrap(async (req, res) => {
  const peer = pbx.peers.get(req.params.name);
  if (!peer) return res.status(404).json({ error: "ترانک پیدا نشد" });
  if (peer.tech === "SIP") await ami.action({ Action: "SIPqualifypeer", Peer: peer.name });
  else await ami.action({ Action: "PJSIPQualify", Endpoint: peer.name });
  setTimeout(() => pbx.syncPeers().catch(() => {}), 1500);
  res.json({ ok: true });
}));
app.get("/api/peers/:name", wrap(async (req, res) => {
  const peer = pbx.peers.get(req.params.name);
  if (!peer || !peerVisible(req.user, peer)) return res.status(404).json({ error: "پیدا نشد" });
  if (peer.tech === "SIP") await pbx.peerDetail(peer.name).catch(() => {});
  res.json(peerView(req.user, pbx.peers.get(req.params.name)));
}));

const RELOADS = { sip: "sip reload", pjsip: "module reload res_pjsip.so", dialplan: "dialplan reload", all: "reload" };
app.post("/api/pbx/reload", requirePerm("trunks.manage"), wrap(async (req, res) => {
  const cmd = RELOADS[req.body?.what] || RELOADS.sip;
  const output = await ami.command(cmd);
  await audit(req, "reload", cmd);
  setTimeout(() => { pbx.syncPeers().then(() => pbx.queueAllDetails()).catch(() => {}); pbx.syncRegistry().catch(() => {}); }, 1500);
  res.json({ ok: true, output });
}));
app.get("/api/pbx/info", wrap(async (req, res) => {
  const out = {};
  for (const [k, cmd] of [["uptime", "core show uptime"], ["calls", "core show calls"]]) out[k] = await ami.command(cmd).catch(() => []);
  res.json({ ...ami.info(), ...out });
}));
app.get("/api/pbx/config/:file", requirePerm("trunks.manage"), wrap(async (req, res) => {
  if (!/^[A-Za-z0-9_.-]+\.conf$/.test(req.params.file)) return res.status(400).json({ error: "نام فایل نامعتبر" });
  res.json(await getConfig(ami, req.params.file));
}));
app.get("/api/pbx/backups", requirePerm("trunks.manage"), wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, at, filename, username, note FROM config_backups ORDER BY id DESC LIMIT 100`);
  res.json(rows);
}));
app.get("/api/pbx/backups/:id", requirePerm("trunks.manage"), wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM config_backups WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "پیدا نشد" });
  res.json(rows[0]);
}));

// ---------- phonebook ----------
const visible = `(c.shared OR c.owner_id = $1)`;
app.use("/api/contacts", requirePerm("phonebook.view", "dialpad.use", "panel.view"));
app.get("/api/contacts", wrap(async (req, res) => {
  const args = [req.user.id];
  let sql = `SELECT c.*, u.full_name AS owner_name FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE ${visible}`;
  if (req.query.q) {
    args.push(`%${String(req.query.q).toLowerCase()}%`);
    sql += ` AND (lower(c.name) LIKE $${args.length} OR lower(c.company) LIKE $${args.length} OR c.phones::text LIKE $${args.length} OR lower(c.notes) LIKE $${args.length})`;
  }
  if (req.query.group) { args.push(req.query.group); sql += ` AND c.group_name = $${args.length}`; }
  if (req.query.favorite === "1") sql += ` AND c.favorite`;
  sql += ` ORDER BY c.favorite DESC, c.name LIMIT 2000`;
  const { rows } = await pool.query(sql, args);
  res.json(rows);
}));

app.get("/api/contacts/lookup", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT c.name, c.company, c.phones FROM contacts c WHERE ${visible}`, [req.user.id]);
  const map = {};
  for (const r of rows) for (const p of r.phones || []) {
    const n = normalizeNumber(p.number);
    if (n) map[n] = r.company ? `${r.name} (${r.company})` : r.name;
  }
  res.json(map);
}));

app.get("/api/contacts/groups", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT group_name, count(*)::int AS n FROM contacts c WHERE ${visible} AND group_name <> '' GROUP BY group_name ORDER BY group_name`, [req.user.id]);
  res.json(rows);
}));

function contactInput(b) {
  const phones = (Array.isArray(b.phones) ? b.phones : []).map((p) => ({ label: String(p.label || "").slice(0, 30), number: String(p.number || "").replace(/[^\d*#+]/g, "").slice(0, 32) })).filter((p) => p.number);
  if (!String(b.name || "").trim()) throw Object.assign(new Error("نام مخاطب الزامی است"), { status: 400 });
  if (!phones.length) throw Object.assign(new Error("حداقل یک شماره وارد کنید"), { status: 400 });
  return [String(b.name).trim().slice(0, 120), String(b.company || "").slice(0, 120), String(b.title || "").slice(0, 80), JSON.stringify(phones),
    String(b.email || "").slice(0, 120), String(b.group_name || "").slice(0, 60), String(b.notes || "").slice(0, 2000), !!b.favorite, b.shared !== false];
}

async function canEditContact(req, id) {
  const { rows } = await pool.query(`SELECT owner_id, shared FROM contacts WHERE id = $1`, [id]);
  if (!rows[0]) return false;
  return rows[0].owner_id === req.user.id || can(req.user, "phonebook.edit_shared");
}

app.post("/api/contacts", requirePerm("phonebook.view"), wrap(async (req, res) => {
  const v = contactInput(req.body || {});
  const { rows } = await pool.query(`INSERT INTO contacts (name, company, title, phones, email, group_name, notes, favorite, shared, owner_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [...v, req.user.id]);
  res.json(rows[0]);
}));
app.put("/api/contacts/:id", requirePerm("phonebook.view"), wrap(async (req, res) => {
  if (!(await canEditContact(req, req.params.id))) return res.status(403).json({ error: "اجازه ویرایش این مخاطب را ندارید" });
  const v = contactInput(req.body || {});
  const { rows } = await pool.query(`UPDATE contacts SET name=$1, company=$2, title=$3, phones=$4, email=$5, group_name=$6, notes=$7, favorite=$8, shared=$9, updated_at=now()
    WHERE id=$10 RETURNING *`, [...v, req.params.id]);
  res.json(rows[0]);
}));
app.delete("/api/contacts/:id", requirePerm("phonebook.view"), wrap(async (req, res) => {
  if (!(await canEditContact(req, req.params.id))) return res.status(403).json({ error: "اجازه حذف این مخاطب را ندارید" });
  await pool.query(`DELETE FROM contacts WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

const CSV_HEAD = ["name", "company", "title", "mobile", "work", "home", "other", "email", "group", "notes"];
const CSV_LABELS = { mobile: "موبایل", work: "محل کار", home: "منزل", other: "سایر" };
app.get("/api/contacts/export.csv", wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM contacts c WHERE ${visible} ORDER BY name`, [req.user.id]);
  const data = rows.map((r) => {
    const by = (label) => (r.phones || []).filter((p) => p.label === label).map((p) => p.number).join(" ");
    const known = new Set(Object.values(CSV_LABELS));
    return [r.name, r.company, r.title, by(CSV_LABELS.mobile), by(CSV_LABELS.work), by(CSV_LABELS.home),
      (r.phones || []).filter((p) => !known.has(p.label) || p.label === CSV_LABELS.other).map((p) => p.number).join(" "), r.email, r.group_name, r.notes];
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="phonebook.csv"`);
  res.send("﻿" + toCsv([CSV_HEAD, ...data]));
}));
app.post("/api/contacts/import", requirePerm("phonebook.view"), wrap(async (req, res) => {
  const rows = parseCsv(typeof req.body === "string" ? req.body.replace(/^﻿/, "") : "");
  if (rows.length < 2) return res.status(400).json({ error: "فایل CSV خالی است" });
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => head.indexOf(n);
  if (idx("name") < 0) return res.status(400).json({ error: "ستون name در سطر اول لازم است (از خروجی نمونه استفاده کنید)" });
  let added = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const get = (n) => (idx(n) >= 0 ? String(r[idx(n)] || "").trim() : "");
    const phones = [];
    for (const k of ["mobile", "work", "home", "other", "phone", "number"]) for (const num of get(k).split(/[\s,;]+/).filter(Boolean)) phones.push({ label: CSV_LABELS[k] || "سایر", number: num });
    try {
      const v = contactInput({ name: get("name"), company: get("company"), title: get("title"), phones, email: get("email"), group_name: get("group"), notes: get("notes") });
      await pool.query(`INSERT INTO contacts (name, company, title, phones, email, group_name, notes, favorite, shared, owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...v, req.user.id]);
      added++;
    } catch { skipped++; }
  }
  await audit(req, "contacts:import", "", { added, skipped });
  res.json({ added, skipped });
}));

// ---------- CDR reports ----------
app.get("/api/cdr", requirePerm("reports.view"), wrap(async (req, res) => res.json(await listCdr(scopeCdr(req)))));
app.get("/api/cdr/stats", requirePerm("reports.view"), wrap(async (req, res) => res.json(await cdrStats(scopeCdr(req)))));
app.get("/api/cdr/export.csv", requirePerm("reports.export"), wrap(async (req, res) => {
  const rows = await exportCdr(scopeCdr(req));
  const DIR = { inbound: "ورودی", outbound: "خروجی", internal: "داخلی", other: "سایر" };
  const DISP = { ANSWERED: "پاسخ داده شده", "NO ANSWER": "بی‌پاسخ", BUSY: "مشغول", FAILED: "ناموفق", CONGESTION: "ازدحام" };
  const { toJalaliString } = await import("./util.js");
  const data = rows.map((r) => [toJalaliString(r.calldate), r.calldate, DIR[r.direction], r.src, r.dst, r.clid, DISP[r.disposition] || r.disposition, r.duration, r.billsec, r.channel, r.dstchannel, r.uniqueid]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="cdr-report.csv"`);
  res.send("﻿" + toCsv([["تاریخ شمسی", "تاریخ میلادی", "نوع", "مبدأ", "مقصد", "Caller ID", "وضعیت", "مدت کل (ثانیه)", "مدت مکالمه (ثانیه)", "کانال", "کانال مقصد", "شناسه"], ...data]));
}));
/** Limit CDR to the extensions the user's "reports" scope allows (resolved against the PBX's extension list). */
function scopeCdr(req) {
  const q = { ...req.query };
  const u = req.user;
  if (u.isAdmin || (u.scopes?.reports?.mode || "all") === "all") return q;
  const known = [...pbx.peers.values()].filter((p) => p.kind === "extension").map((p) => p.name);
  if (u.extension && !known.includes(u.extension)) known.push(u.extension);
  let allowed = known.filter((e) => inScope(u, "reports", e));
  if (u.scopes.reports.mode === "list") allowed = [...new Set([...allowed, ...String(u.scopes.reports.list).split(/[,\s]+/).filter((t) => /^\d+$/.test(t))])];
  const asked = String(q.extension || "").split(/[,\s]+/).filter(Boolean);
  const final = asked.length ? asked.filter((e) => allowed.includes(e)) : allowed;
  q.extension = final.length ? final.join(",") : "__none__";
  return q;
}

// ---------- settings / users / audit (admin) ----------
app.get("/api/settings", requirePerm("settings.manage"), (req, res) => res.json({ ...publicSettings(), ami: { ...publicSettings().ami, status: ami.info() } }));
app.put("/api/settings/:key", requirePerm("settings.manage"), wrap(async (req, res) => {
  const k = req.params.key;
  if (!["ami", "cdr", "dial", "system"].includes(k)) return res.status(404).json({ error: "تنظیم نامعتبر" });
  const body = { ...req.body };
  for (const f of ["status", "secretSet", "passwordSet", "sshPasswordSet", "sshKeySet"]) delete body[f];
  if (k === "system") {
    if (body.method && !["ami", "ssh", "off"].includes(body.method)) return res.status(400).json({ error: "روش نامعتبر" });
    if (body.services !== undefined && !/^[\w.|, -]*$/.test(body.services)) return res.status(400).json({ error: "نام سرویس‌ها فقط حروف انگلیسی، عدد و | ," });
  }
  if (k === "dial") {
    if (body.tech && !["SIP", "PJSIP", "Local"].includes(body.tech)) return res.status(400).json({ error: "نوع کانال نامعتبر" });
    if (body.context && !/^[A-Za-z0-9_-]+$/.test(body.context)) return res.status(400).json({ error: "Context نامعتبر" });
    if (body.trunkConfigFile && !/^[A-Za-z0-9_.-]+\.conf$/.test(body.trunkConfigFile)) return res.status(400).json({ error: "نام فایل نامعتبر" });
    if (body.extensionPattern !== undefined) try { body.extensionPattern = checkDialplanList(body.extensionPattern); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  await saveSettings(k, body);
  if (k === "ami") ami.configure(settings().ami);
  if (k === "cdr") resetCdrPool();
  if (k === "dial") pbx.reclassify();
  if (k === "system") system.schedule();
  await audit(req, `settings:${k}`);
  res.json({ ok: true });
}));
app.post("/api/settings/system/test", requirePerm("settings.manage"), wrap(async (req, res) => {
  const b = { ...settings().system, ...req.body };
  if (!b.sshPassword) b.sshPassword = settings().system.sshPassword;
  if (!b.sshKey) b.sshKey = settings().system.sshKey;
  const svc = String(b.services || "").split(/[,\s]+/).filter(Boolean);
  try {
    if (b.method === "ssh") {
      const m = parseMetrics(await sshExec(b, metricsScript(svc).replace(" | tr '\\n' ';'", "")), svc);
      return res.json({ ok: m.memory !== undefined, result: m });
    }
    const r = await ami.action({ Action: "Getvar", Variable: `SHELL(${metricsScript(svc)})` }, 15000);
    if (r.Response !== "Success" || !r.Value) return res.json({ ok: false, error: r.Message || "خروجی SHELL خالی بود (func_shell / live_dangerously)" });
    res.json({ ok: true, result: parseMetrics(r.Value, svc) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
}));
app.post("/api/settings/ami/test", requirePerm("settings.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await testAmi({ host: b.host, port: Number(b.port) || 5038, username: b.username, secret: b.secret || settings().ami.secret }));
}));
app.post("/api/settings/cdr/test", requirePerm("settings.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  try { res.json(await testCdr({ ...b, password: b.password || settings().cdr.password })); }
  catch (err) { res.json({ ok: false, error: err.message }); }
}));

app.get("/api/users", requirePerm("users.manage"), wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT u.id, u.username, u.full_name, u.extension, u.active, u.group_id, u.created_at, g.name AS group_name
    FROM users u LEFT JOIN access_groups g ON g.id = u.group_id ORDER BY u.id`);
  res.json(rows);
}));
async function checkGroup(id) {
  if (!id) throw Object.assign(new Error("گروه دسترسی کاربر را انتخاب کنید"), { status: 400 });
  const { rows } = await pool.query(`SELECT id FROM access_groups WHERE id = $1`, [id]);
  if (!rows[0]) throw Object.assign(new Error("گروه دسترسی پیدا نشد"), { status: 400 });
}
async function adminCount(exceptUser) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users u JOIN access_groups g ON g.id = u.group_id WHERE g.is_admin AND u.active AND u.id <> $1`, [exceptUser || 0]);
  return rows[0].n;
}
app.post("/api/users", requirePerm("users.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(b.username || "")) return res.status(400).json({ error: "نام کاربری: حروف انگلیسی/عدد، حداقل ۳ کاراکتر" });
  if (String(b.password || "").length < 6) return res.status(400).json({ error: "رمز حداقل ۶ کاراکتر" });
  await checkGroup(b.group_id);
  try {
    const { rows } = await pool.query(`INSERT INTO users (username, full_name, password_hash, extension, group_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.username, String(b.full_name || ""), hashPassword(b.password), String(b.extension || "").trim(), b.group_id]);
    await audit(req, "user:create", b.username, { group_id: b.group_id });
    res.json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "این نام کاربری وجود دارد" });
    throw err;
  }
}));
app.put("/api/users/:id", requirePerm("users.manage"), wrap(async (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  await checkGroup(b.group_id);
  if (b.password && String(b.password).length < 6) return res.status(400).json({ error: "رمز حداقل ۶ کاراکتر" });
  const { rows: [g] } = await pool.query(`SELECT is_admin FROM access_groups WHERE id = $1`, [b.group_id]);
  if ((!g.is_admin || b.active === false) && (await adminCount(id)) === 0) return res.status(400).json({ error: "حداقل یک کاربر فعال در گروه مدیران سیستم باید بماند" });
  await pool.query(`UPDATE users SET full_name=$1, extension=$2, active=$3, group_id=$4 WHERE id=$5`, [String(b.full_name || ""), String(b.extension || "").trim(), b.active !== false, b.group_id, id]);
  if (b.password) await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(b.password), id]);
  forgetUser(id);
  await audit(req, "user:update", id, { group_id: b.group_id });
  res.json({ ok: true });
}));
app.delete("/api/users/:id", requirePerm("users.manage"), wrap(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "حساب خودتان را نمی‌توانید حذف کنید" });
  if ((await adminCount(Number(req.params.id))) === 0) return res.status(400).json({ error: "حداقل یک کاربر فعال در گروه مدیران سیستم باید بماند" });
  await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  forgetUser(Number(req.params.id));
  await audit(req, "user:delete", req.params.id);
  res.json({ ok: true });
}));

app.get("/api/groups", requirePerm("users.manage"), wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT g.*, (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS users FROM access_groups g ORDER BY g.id`);
  res.json({ groups: rows, permissions: PERMISSIONS, scopes: SCOPES });
}));
app.post("/api/groups", requirePerm("users.manage"), wrap(async (req, res) => {
  const g = cleanGroup(req.body || {});
  if (g.is_admin && !req.user.isAdmin) return res.status(403).json({ error: "فقط مدیر سیستم می‌تواند گروه مدیر بسازد" });
  try {
    const { rows } = await pool.query(`INSERT INTO access_groups (name, description, is_admin, permissions, scopes) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [g.name, g.description, g.is_admin, g.permissions, g.scopes]);
    await audit(req, "group:create", g.name);
    res.json({ id: rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "گروهی با این نام وجود دارد" });
    throw err;
  }
}));
app.put("/api/groups/:id", requirePerm("users.manage"), wrap(async (req, res) => {
  const g = cleanGroup(req.body || {});
  const id = Number(req.params.id);
  const { rows: [old] } = await pool.query(`SELECT is_admin FROM access_groups WHERE id = $1`, [id]);
  if (!old) return res.status(404).json({ error: "گروه پیدا نشد" });
  if ((g.is_admin || old.is_admin) && !req.user.isAdmin) return res.status(403).json({ error: "فقط مدیر سیستم می‌تواند گروه مدیر را تغییر دهد" });
  if (old.is_admin && !g.is_admin) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users u JOIN access_groups g ON g.id = u.group_id WHERE g.is_admin AND u.active AND g.id <> $1`, [id]);
    if (!rows[0].n) return res.status(400).json({ error: "این تنها گروه مدیر است؛ حالت مدیر را نمی‌توان برداشت" });
  }
  try {
    await pool.query(`UPDATE access_groups SET name=$1, description=$2, is_admin=$3, permissions=$4, scopes=$5 WHERE id=$6`,
      [g.name, g.description, g.is_admin, g.permissions, g.scopes, id]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "گروهی با این نام وجود دارد" });
    throw err;
  }
  forgetUser();
  await audit(req, "group:update", g.name);
  res.json({ ok: true });
}));
app.delete("/api/groups/:id", requirePerm("users.manage"), wrap(async (req, res) => {
  const { rows: [g] } = await pool.query(`SELECT g.name, g.is_admin, (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS n FROM access_groups g WHERE g.id = $1`, [req.params.id]);
  if (!g) return res.status(404).json({ error: "گروه پیدا نشد" });
  if (g.n) return res.status(400).json({ error: `${g.n} کاربر در این گروه هستند؛ ابتدا آن‌ها را به گروه دیگری منتقل کنید` });
  await pool.query(`DELETE FROM access_groups WHERE id = $1`, [req.params.id]);
  await audit(req, "group:delete", g.name);
  res.json({ ok: true });
}));

// ---------- queues ----------
app.get("/api/queues", requirePerm("queues.view"), (req, res) => res.json(queueView(req.user, queues.queues)));
async function queueAction(req, res, action, okText) {
  const queue = String(req.body?.queue || "");
  const iface = String(req.body?.interface || "");
  if (queue && !inScope(req.user, "queues", queue)) return res.status(403).json({ error: "این صف در محدوده دسترسی شما نیست" });
  if (!/^(SIP|PJSIP|IAX2|Local|Agent)\/[\w@.-]+$/i.test(iface)) return res.status(400).json({ error: "عضو صف نامعتبر است" });
  const r = await ami.action({ ...action, Interface: iface, ...(queue ? { Queue: queue } : {}) });
  if (r.Response !== "Success") return res.status(502).json({ error: r.Message || "عملیات صف ناموفق بود" });
  await audit(req, `queue:${action.Action}`, `${queue} ${iface}`, action.Paused ? { paused: action.Paused, reason: action.Reason } : {});
  setTimeout(() => queues.refresh(), 300);
  res.json({ ok: true, message: okText });
}
app.post("/api/queues/pause", requirePerm("queues.manage"), wrap((req, res) =>
  queueAction(req, res, { Action: "QueuePause", Paused: req.body?.paused ? "true" : "false", Reason: String(req.body?.reason || "").slice(0, 40) })));
app.post("/api/queues/add", requirePerm("queues.manage"), wrap((req, res) => {
  if (!req.body?.queue) return res.status(400).json({ error: "صف را مشخص کنید" });
  return queueAction(req, res, { Action: "QueueAdd", Penalty: Number(req.body?.penalty) || 0, MemberName: String(req.body?.name || "").slice(0, 40) || undefined, Paused: "false" });
}));
app.post("/api/queues/remove", requirePerm("queues.manage"), wrap((req, res) => {
  if (!req.body?.queue) return res.status(400).json({ error: "صف را مشخص کنید" });
  return queueAction(req, res, { Action: "QueueRemove" });
}));

// ---------- server status ----------
app.get("/api/system", requirePerm("system.view", "dashboard.view"), wrap(async (req, res) => {
  if (req.query.refresh === "1" || !system.latest) await system.sample().catch(() => {});
  res.json({ latest: system.latest, history: req.query.history === "0" ? [] : system.history });
}));

// ---------- dashboard ----------
app.get("/api/dashboard/series", requirePerm("dashboard.view"), wrap(async (req, res) => res.json(await series(String(req.query.range || "6h")))));
app.get("/api/dashboard/summary", requirePerm("dashboard.view"), wrap(async (req, res) => {
  const out = { peaks: await peaks().catch(() => null), cdr: null };
  if (can(req.user, "reports.view")) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.cdr = await cdrStats(scopeCdr({ user: req.user, query: { from: `${day} 00:00:00`, to: `${day} 23:59:59` } })).then((s) => ({ totals: s.totals, byHour: s.byHour }), (e) => ({ error: e.message }));
  }
  res.json(out);
}));

app.get("/api/audit", requirePerm("audit.view"), wrap(async (req, res) => {
  const args = [];
  let sql = `SELECT * FROM audit_log WHERE 1=1`;
  if (req.query.action) { args.push(`${req.query.action}%`); sql += ` AND action LIKE $${args.length}`; }
  sql += ` ORDER BY id DESC LIMIT 300`;
  const { rows } = await pool.query(sql, args);
  res.json(rows);
}));

app.use("/api", (req, res) => res.status(404).json({ error: "مسیر API پیدا نشد" }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (/AMI/.test(err.message) ? 503 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" ? "اتصال به دیتابیس CDR برقرار نشد" : err.message || "خطای داخلی" });
});

// ---------- static web app ----------
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws).*/, (req, res) => res.sendFile(path.join(dist, "index.html")));
}

// ---------- WebSocket live feed (filtered per user) ----------
function snapshotFor(user, idx = callIndex()) {
  const snap = pbx.snapshot();
  const trunks = can(user, "trunks.view");
  return {
    ami: snap.ami,
    peers: snap.peers.filter((p) => peerVisible(user, p)).map((p) => peerView(user, p)),
    channels: snap.channels.filter((c) => channelVisible(user, c, idx)),
    registrations: trunks ? snap.registrations : [],
    dahdi: trunks ? snap.dahdi : [],
    queues: queueView(user, queues.queues),
  };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  if (!req.url.startsWith("/ws")) return socket.destroy();
  const user = await userFromRequest(req).catch(() => null);
  if (!user) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.cookie = req.headers.cookie;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    sendSnapshot(ws);
  });
});

function sendSnapshot(ws, idx) {
  const snap = snapshotFor(ws.user, idx);
  ws.sent = new Set(snap.channels.map((c) => c.name));
  ws.send(JSON.stringify({ type: "snapshot", data: snap }));
}

let queue = [];
let flushTimer = null;
const enqueue = (item) => {
  if (item.type === "reset") queue = [];
  queue.push(item);
  if (!flushTimer) flushTimer = setTimeout(flush, 150);
};
pbx.on("change", enqueue);
queues.on("change", enqueue);

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  const items = queue;
  queue = [];
  const idx = callIndex();
  const reset = items.some((i) => i.type === "reset");
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (reset) { sendSnapshot(ws, idx); continue; }
    const u = ws.user;
    const out = [];
    for (const it of items) {
      switch (it.type) {
        case "peer": if (peerVisible(u, it.data)) out.push({ type: "peer", data: peerView(u, it.data) }); break;
        case "peerDel": out.push(it); break;
        case "channel": {
          const live = pbx.channels.get(it.data.name);
          if (live && channelVisible(u, live, idx)) { ws.sent.add(it.data.name); out.push({ type: "channel", data: live }); }
          else if (ws.sent.has(it.data.name)) { ws.sent.delete(it.data.name); out.push({ type: "channelDel", name: it.data.name }); }
          break;
        }
        case "channelDel": if (ws.sent.delete(it.name)) out.push(it); break;
        case "registrations": case "dahdi": if (can(u, "trunks.view")) out.push(it); break;
        case "queues": out.push({ type: "queues", data: queueView(u, it.data) }); break;
        default: out.push(it);
      }
    }
    // channels that became visible through a bridge change on another channel
    for (const ch of pbx.channels.values()) {
      if (!ws.sent.has(ch.name) && channelVisible(u, ch, idx)) { ws.sent.add(ch.name); out.push({ type: "channel", data: ch }); }
    }
    if (out.length) ws.send(JSON.stringify({ type: "batch", items: dedupe(out) }));
  }
}
/** Keep only the latest update per entity within one batch. */
function dedupe(items) {
  const last = new Map();
  items.forEach((it, i) => last.set(`${it.type.replace(/Del$/, "")}:${it.data?.name ?? it.name ?? it.type}`, i));
  return items.filter((it, i) => last.get(`${it.type.replace(/Del$/, "")}:${it.data?.name ?? it.name ?? it.type}`) === i);
}
// user/group edits take effect on open sockets within a few seconds
setInterval(async () => {
  for (const ws of wss.clients) {
    const fresh = await userFromRequest({ headers: { cookie: ws.cookie } }).catch(() => null);
    if (ws.cookie && !fresh) { ws.close(4001, "session ended"); continue; }
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(ws.user)) { ws.user = fresh; sendSnapshot(ws); }
  }
}, 15000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

const port = Number(process.env.PORT) || 3400;
server.listen(port, () => console.log(`[panel] listening on :${port}`));
