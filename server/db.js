// PostgreSQL access, append-only migrations, settings store with encrypted secrets.
import pg from "pg";
import crypto from "node:crypto";

// Day boundaries (today's peak, reports) follow the PBX's local time zone.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, options: `-c TimeZone=${process.env.TZ || "Asia/Tehran"}` });
// An idle client dropped by the server (Postgres restart, network) must not crash the panel; the pool reconnects on next use.
pool.on("error", (err) => console.error(`[db] idle connection lost: ${err.message}`));

// Append-only: never edit an applied migration, add a new one.
const MIGRATIONS = [
  `CREATE TABLE users (
     id serial PRIMARY KEY,
     username text NOT NULL UNIQUE,
     full_name text NOT NULL DEFAULT '',
     password_hash text NOT NULL,
     role text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','supervisor','operator')),
     extension text NOT NULL DEFAULT '',
     active boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE contacts (
     id serial PRIMARY KEY,
     name text NOT NULL,
     company text NOT NULL DEFAULT '',
     title text NOT NULL DEFAULT '',
     phones jsonb NOT NULL DEFAULT '[]',
     email text NOT NULL DEFAULT '',
     group_name text NOT NULL DEFAULT '',
     notes text NOT NULL DEFAULT '',
     favorite boolean NOT NULL DEFAULT false,
     shared boolean NOT NULL DEFAULT true,
     owner_id integer REFERENCES users(id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX contacts_name_idx ON contacts (lower(name));
   CREATE TABLE audit_log (
     id bigserial PRIMARY KEY,
     at timestamptz NOT NULL DEFAULT now(),
     user_id integer,
     username text NOT NULL DEFAULT '',
     action text NOT NULL,
     target text NOT NULL DEFAULT '',
     details jsonb NOT NULL DEFAULT '{}',
     ip text NOT NULL DEFAULT ''
   );
   CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
   CREATE TABLE config_backups (
     id serial PRIMARY KEY,
     at timestamptz NOT NULL DEFAULT now(),
     filename text NOT NULL,
     content jsonb NOT NULL,
     username text NOT NULL DEFAULT '',
     note text NOT NULL DEFAULT ''
   );`,
  `CREATE TABLE access_groups (
     id serial PRIMARY KEY,
     name text NOT NULL UNIQUE,
     description text NOT NULL DEFAULT '',
     is_admin boolean NOT NULL DEFAULT false,
     permissions text[] NOT NULL DEFAULT '{}',
     scopes jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   );
   ALTER TABLE users ADD COLUMN group_id integer REFERENCES access_groups(id) ON DELETE SET NULL;
   CREATE TABLE call_samples (
     at timestamptz PRIMARY KEY,
     total integer NOT NULL,
     inbound integer NOT NULL,
     outbound integer NOT NULL,
     internal integer NOT NULL,
     ringing integer NOT NULL,
     queue_waiting integer NOT NULL DEFAULT 0,
     online_exts integer NOT NULL DEFAULT 0
   );`,
  `CREATE TABLE pbx_servers (
     id serial PRIMARY KEY,
     name text NOT NULL,
     enabled boolean NOT NULL DEFAULT true,
     sort integer NOT NULL DEFAULT 0,
     config jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   );
   ALTER TABLE call_samples ADD COLUMN server_id integer NOT NULL DEFAULT 1;
   ALTER TABLE call_samples DROP CONSTRAINT call_samples_pkey;
   ALTER TABLE call_samples ADD PRIMARY KEY (server_id, at);
   ALTER TABLE config_backups ADD COLUMN server_id integer;
   ALTER TABLE audit_log ADD COLUMN server_id integer;
   ALTER TABLE access_groups ADD COLUMN servers jsonb NOT NULL DEFAULT '{"mode":"all","ids":[]}';`,
];

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query(`SELECT version FROM schema_migrations`);
  const done = new Set(rows.map((r) => r.version));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (done.has(i + 1)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(MIGRATIONS[i]);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [i + 1]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  }
}

// ---------- secrets ----------
const key = () => crypto.createHash("sha256").update(`settings:${process.env.APP_SECRET}`).digest();

export function encrypt(text) {
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")}`;
}

export function decrypt(value) {
  if (!value || !String(value).startsWith("enc:")) return value || "";
  try {
    const raw = Buffer.from(value.slice(4), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}

// ---------- settings ----------
export const DEFAULTS = {
  ami: { host: "", port: 5038, username: "", secret: "" },
  cdr: { via: "direct", host: "", port: 3306, user: "", password: "", database: "asteriskcdrdb", table: "cdr", // via: direct | ssh
    recordings: "ssh", recordingsPath: "/var/spool/asterisk/monitor" }, // recordings: ssh (SFTP) | url (dial.recordingUrl) | off
  dial: {
    tech: "SIP",              // SIP | PJSIP | Local
    context: "from-internal",
    autoAnswer: false,
    extensionPattern: "_XX, _XXX, _XXXX, _XXXXX", // Asterisk dialplan patterns
    hideLocal: true,
    trunkConfigFile: "sip_custom.conf",
    recordingUrl: "",         // e.g. http://pbx/recordings/{recordingfile}
    minExternalLength: 5,
  },
  system: {
    method: "ami",            // ami (core show sysinfo + SHELL via Getvar) | ssh | off
    sshHost: "", sshPort: 22, sshUser: "", sshPassword: "", sshKey: "",
    interval: 5,              // seconds between samples (pushed live to dashboards)
    services: "asterisk,mysqld|mariadbd,httpd,fail2ban-server,sshd,crond",
  },
};
const SECRET_FIELDS = { ami: ["secret"], cdr: ["password"], system: ["sshPassword", "sshKey"] };

let cache = null;

export async function loadSettings() {
  const { rows } = await pool.query(`SELECT key, value FROM settings`);
  const out = structuredClone(DEFAULTS);
  for (const r of rows) if (out[r.key]) out[r.key] = { ...out[r.key], ...r.value };
  for (const [k, fields] of Object.entries(SECRET_FIELDS)) for (const f of fields) out[k][f] = decrypt(out[k][f]);
  // early versions stored a regex; the setting now uses Asterisk dialplan patterns
  if (String(out.dial.extensionPattern).startsWith("^")) out.dial.extensionPattern = DEFAULTS.dial.extensionPattern;
  cache = out;
  return out;
}

export function settings() { return cache || structuredClone(DEFAULTS); }

export async function saveSettings(keyName, value) {
  const current = settings()[keyName];
  const merged = { ...current, ...value };
  const stored = { ...merged };
  for (const f of SECRET_FIELDS[keyName] || []) {
    // empty secret in the form means "keep the existing one"
    if (value[f] === undefined || value[f] === "") merged[f] = current[f];
    stored[f] = encrypt(merged[f]);
  }
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [keyName, stored]);
  cache = { ...settings(), [keyName]: merged };
  return merged;
}

/** Settings for the browser: secrets replaced by a "set" flag. */
export function publicSettings() {
  const s = structuredClone(settings());
  for (const [k, fields] of Object.entries(SECRET_FIELDS)) for (const f of fields) { s[k][`${f}Set`] = !!s[k][f]; s[k][f] = ""; }
  return s;
}

export async function audit(req, action, target = "", details = {}) {
  await pool.query(`INSERT INTO audit_log (user_id, username, action, target, details, ip, server_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user?.id || null, req.user?.username || "", action, String(target), details, req.ip || "", req.srv?.id ?? null]).catch(() => {});
}

// ---------- PBX servers ----------
// Each server row keeps its own ami / cdr / dial / system sections (same shape as DEFAULTS, secrets encrypted).
export const SERVER_SECTIONS = ["ami", "cdr", "dial", "system"];
let servers = new Map();

function decodeServer(row) {
  const config = {};
  for (const k of SERVER_SECTIONS) {
    config[k] = { ...structuredClone(DEFAULTS[k]), ...(row.config?.[k] || {}) };
    for (const f of SECRET_FIELDS[k] || []) config[k][f] = decrypt(config[k][f]);
  }
  if (String(config.dial.extensionPattern).startsWith("^")) config.dial.extensionPattern = DEFAULTS.dial.extensionPattern;
  if (Number(config.system.interval) === 15) config.system.interval = 5; // old default; dashboards are live now
  return { id: row.id, name: row.name, enabled: row.enabled, sort: row.sort, config };
}

function encodeConfig(config) {
  const out = {};
  for (const k of SERVER_SECTIONS) {
    out[k] = { ...config[k] };
    for (const f of SECRET_FIELDS[k] || []) out[k][f] = encrypt(out[k][f]);
  }
  return out;
}

export async function loadServers() {
  const { rows } = await pool.query(`SELECT * FROM pbx_servers ORDER BY sort, id`);
  servers = new Map(rows.map((r) => [r.id, decodeServer(r)]));
  return [...servers.values()];
}
export const listServers = () => [...servers.values()].sort((a, b) => a.sort - b.sort || a.id - b.id);
export const getServer = (id) => servers.get(Number(id)) || null;

/** First run after the multi-server upgrade: the old single-server settings become server #1. */
export async function ensureServers() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pbx_servers`);
  if (rows[0].n === 0) {
    const legacy = settings();
    const config = Object.fromEntries(SERVER_SECTIONS.map((k) => [k, legacy[k]]));
    await pool.query(`INSERT INTO pbx_servers (name, config) VALUES ($1, $2)`, [legacy.ami.host ? `سرور ${legacy.ami.host}` : "سرور اصلی", encodeConfig(config)]);
  }
  return loadServers();
}

export async function createServer({ name, copyFrom }) {
  const base = copyFrom ? getServer(copyFrom)?.config : null;
  const config = Object.fromEntries(SERVER_SECTIONS.map((k) => [k, structuredClone(base ? { ...base[k] } : DEFAULTS[k])]));
  if (base) { config.ami = { ...DEFAULTS.ami }; config.cdr = { ...base.cdr, host: base.cdr.via === "ssh" ? base.cdr.host : "", password: "" }; config.system = { ...base.system, sshHost: "", sshPassword: "", sshKey: "" }; }
  const { rows } = await pool.query(`INSERT INTO pbx_servers (name, config, sort) VALUES ($1, $2, (SELECT COALESCE(max(sort), 0) + 1 FROM pbx_servers)) RETURNING *`,
    [String(name).slice(0, 60), encodeConfig(config)]);
  const s = decodeServer(rows[0]);
  servers.set(s.id, s);
  return s;
}

export async function updateServerMeta(id, { name, enabled, sort }) {
  const s = getServer(id);
  if (!s) return null;
  await pool.query(`UPDATE pbx_servers SET name = $1, enabled = $2, sort = $3 WHERE id = $4`,
    [String(name ?? s.name).slice(0, 60), enabled ?? s.enabled, Number(sort ?? s.sort) || 0, s.id]);
  Object.assign(s, { name: String(name ?? s.name).slice(0, 60), enabled: enabled ?? s.enabled, sort: Number(sort ?? s.sort) || 0 });
  return s;
}

/** Merge one section; an empty secret in the form keeps the stored one. */
export async function saveServerSection(id, key, value) {
  const s = getServer(id);
  if (!s || !SERVER_SECTIONS.includes(key)) return null;
  const merged = { ...s.config[key], ...value };
  for (const f of SECRET_FIELDS[key] || []) if (value[f] === undefined || value[f] === "") merged[f] = s.config[key][f];
  const config = { ...s.config, [key]: merged };
  await pool.query(`UPDATE pbx_servers SET config = $1 WHERE id = $2`, [encodeConfig(config), s.id]);
  s.config = config;
  return s;
}

export async function deleteServer(id) {
  await pool.query(`DELETE FROM pbx_servers WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM call_samples WHERE server_id = $1`, [id]);
  servers.delete(Number(id));
}

/** A server's config for the browser: secrets replaced by "<field>Set" flags. */
export function publicServerConfig(s) {
  const c = structuredClone(s.config);
  for (const [k, fields] of Object.entries(SECRET_FIELDS)) for (const f of fields) { c[k][`${f}Set`] = !!c[k][f]; c[k][f] = ""; }
  return c;
}
