// Password hashing (scrypt) and stateless signed session cookies.
import crypto from "node:crypto";
import { pool } from "./db.js";

const COOKIE = "ap_session";
const TTL = 12 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), Buffer.from(salt, "hex"), 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

const sign = (data) => crypto.createHmac("sha256", process.env.APP_SECRET).update(data).digest("base64url");

export function issueToken(user) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + TTL })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(req, res, user) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${COOKIE}=${issueToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${secure ? "; Secure" : ""}`);
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const userCache = new Map(); // uid → {user, at}

export async function userFromRequest(req) {
  const data = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (!data) return null;
  const hit = userCache.get(data.uid);
  if (hit && Date.now() - hit.at < 10000) return hit.user;
  const user = await loadUser(data.uid);
  userCache.set(data.uid, { user, at: Date.now() });
  return user;
}

/** User with its access group flattened: perms[], scopes{}, isAdmin. */
export async function loadUser(id) {
  const { rows } = await pool.query(`SELECT u.id, u.username, u.full_name, u.extension, u.active, u.group_id,
      g.name AS group_name, g.is_admin, g.permissions, g.scopes, g.servers
    FROM users u LEFT JOIN access_groups g ON g.id = u.group_id WHERE u.id = $1`, [id]);
  const r = rows[0];
  if (!r?.active) return null;
  return { id: r.id, username: r.username, full_name: r.full_name, extension: r.extension, group_id: r.group_id,
    group_name: r.group_name || "", isAdmin: !!r.is_admin, perms: r.permissions || [], scopes: r.scopes || {}, servers: r.servers || { mode: "all", ids: [] } };
}

export function forgetUser(id) { if (id === undefined) userCache.clear(); else userCache.delete(id); }

export function requireAuth(req, res, next) {
  userFromRequest(req).then((user) => {
    if (!user) return res.status(401).json({ error: "ابتدا وارد شوید" });
    req.user = user;
    next();
  }, next);
}

export async function ensureAdmin() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n > 0) return;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  await pool.query(`INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, 'مدیر سیستم', $2, 'admin')`, [username, hashPassword(password)]);
  console.log(`[auth] admin user created: ${username}${process.env.ADMIN_PASSWORD ? "" : ` / ${password}`}`);
}
