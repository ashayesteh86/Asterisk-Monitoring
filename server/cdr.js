// Call detail records from the Asterisk MySQL CDR database (Issabel/Elastix: asteriskcdrdb.cdr).
import mysql from "mysql2/promise";
import { settings } from "./db.js";
import { SshTunnel, sshConfigFrom } from "./tunnel.js";

let pool = null;
let poolKey = "";
let columns = null;
let tunnel = null;

/** Where mysql2 should connect: the server itself, or a local port tunnelled over SSH to it. */
async function endpoint(c, sys, amiHost, keep) {
  if (c.via !== "ssh") return { host: c.host, port: Number(c.port) || 3306, tunnel: null };
  const t = new SshTunnel(sshConfigFrom(sys, amiHost), { host: c.host || "127.0.0.1", port: Number(c.port) || 3306 });
  try {
    await t.check();
    const port = await t.open();
    if (keep) tunnel = t;
    return { host: "127.0.0.1", port, tunnel: t };
  } catch (err) { t.close(); throw err; }
}

async function getPool() {
  const { cdr: c, system, ami } = settings();
  if (!c.user || (c.via !== "ssh" && !c.host)) throw Object.assign(new Error("اتصال دیتابیس CDR در تنظیمات وارد نشده است"), { status: 400 });
  const k = JSON.stringify([c, c.via === "ssh" ? [system.sshHost, system.sshPort, system.sshUser, system.sshPassword, system.sshKey, ami.host] : null]);
  if (pool && k === poolKey) return pool;
  resetCdrPool();
  const ep = await endpoint(c, system, ami.host, true);
  poolKey = k;
  pool = mysql.createPool({ host: ep.host, port: ep.port, user: c.user, password: c.password, database: c.database,
    connectionLimit: 4, connectTimeout: 8000, dateStrings: true, charset: "utf8mb4" });
  return pool;
}

const table = () => {
  const t = settings().cdr.table || "cdr";
  if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error("نام جدول CDR نامعتبر است");
  return "`" + t + "`";
};

async function getColumns() {
  if (columns) return columns;
  const [rows] = await (await getPool()).query(`SHOW COLUMNS FROM ${table()}`);
  columns = new Set(rows.map((r) => r.Field));
  return columns;
}

export async function testCdr(config) {
  const { system, ami } = settings();
  const ep = await endpoint(config, system, ami.host, false);
  let conn;
  try {
    conn = await mysql.createConnection({ host: ep.host, port: ep.port, user: config.user,
      password: config.password, database: config.database, connectTimeout: 8000, dateStrings: true });
    const t = /^[A-Za-z0-9_]+$/.test(config.table || "cdr") ? config.table || "cdr" : "cdr";
    const [rows] = await conn.query(`SELECT count(*) AS n, max(calldate) AS last FROM \`${t}\``);
    return { ok: true, count: Number(rows[0].n), last: rows[0].last };
  } catch (err) {
    const t = ep.tunnel?.lastError;
    if (t === "administratively prohibited") throw new Error("اتصال SSH برقرار شد اما sshd سرور ایزابل تونل را رد کرد (AllowTcpForwarding no). در انتهای /etc/ssh/sshd_config برای همین کاربر بنویسید: Match User <کاربر> سپس AllowTcpForwarding yes و PermitOpen 127.0.0.1:3306، و sshd را ری‌استارت کنید");
    if (t && /Channel open failure/i.test(t)) throw new Error(`اتصال SSH برقرار شد اما سرور ایزابل نتوانست به MySQL روی ${config.host || "127.0.0.1"}:${Number(config.port) || 3306} وصل شود — ${/^(127\.0\.0\.1|localhost)$/.test(String(config.host || "127.0.0.1")) ? "پورت MySQL یا AllowTcpForwarding را بررسی کنید" : "آدرس MySQL را 127.0.0.1 بگذارید (MySQL ایزابل معمولاً فقط روی localhost گوش می‌دهد)"}`);
    throw new Error(t ? `SSH: ${t}` : mysqlError(err));
  } finally {
    await conn?.end().catch(() => {});
    ep.tunnel?.close();
  }
}

/** Common MySQL failures in Persian. */
function mysqlError(err) {
  if (err.code === "ER_ACCESS_DENIED_ERROR") return "نام کاربری یا رمز MySQL اشتباه است، یا این کاربر از این آدرس اجازه ورود ندارد";
  if (err.code === "ER_BAD_DB_ERROR") return "دیتابیس پیدا نشد";
  if (err.code === "ER_NO_SUCH_TABLE") return "جدول CDR پیدا نشد";
  if (err.code === "ECONNREFUSED") return "MySQL روی این آدرس و پورت در دسترس نیست";
  if (err.code === "ETIMEDOUT") return "اتصال به MySQL timeout شد (پورت بسته یا فایروال)";
  if (err.code === "PROTOCOL_CONNECTION_LOST") return "اتصال MySQL قطع شد (از طریق SSH: آدرس/پورت MySQL روی سرور را بررسی کنید)";
  return err.message;
}

export function resetCdrPool() {
  pool?.end().catch(() => {});
  tunnel?.close();
  pool = null; poolKey = ""; columns = null; tunnel = null;
}

const EXT_CH = "'^(SIP|PJSIP|IAX2)/[0-9]{2,6}-'";
const DIRECTION_SQL = {
  inbound: `(channel NOT REGEXP ${EXT_CH} AND channel NOT LIKE 'Local/%')`,
  outbound: `(channel REGEXP ${EXT_CH} AND dstchannel <> '' AND dstchannel NOT REGEXP ${EXT_CH} AND dstchannel NOT LIKE 'Local/%')`,
  internal: `(channel REGEXP ${EXT_CH} AND (dstchannel REGEXP ${EXT_CH} OR (dstchannel = '' AND CHAR_LENGTH(dst) <= 6)))`,
};
const DATETIME = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

/** Build the WHERE clause from report filters. */
function where(q) {
  const parts = ["1=1"];
  const args = [];
  if (q.from && DATETIME.test(q.from)) { parts.push("calldate >= ?"); args.push(q.from); }
  if (q.to && DATETIME.test(q.to)) { parts.push("calldate <= ?"); args.push(q.to); }
  if (q.src) { parts.push("src LIKE ?"); args.push(`%${q.src}%`); }
  if (q.dst) { parts.push("dst LIKE ?"); args.push(`%${q.dst}%`); }
  if (q.number) { parts.push("(src LIKE ? OR dst LIKE ? OR clid LIKE ?)"); args.push(`%${q.number}%`, `%${q.number}%`, `%${q.number}%`); }
  if (q.extension) {
    const exts = String(q.extension).split(/[,\s]+/).filter((x) => /^\w+$/.test(x));
    if (exts.length) {
      parts.push(`(${exts.map(() => "(src = ? OR dst = ? OR channel LIKE ? OR dstchannel LIKE ?)").join(" OR ")})`);
      for (const e of exts) args.push(e, e, `%/${e}-%`, `%/${e}-%`);
    }
  }
  if (q.disposition && ["ANSWERED", "NO ANSWER", "BUSY", "FAILED", "CONGESTION"].includes(q.disposition)) {
    parts.push("disposition = ?"); args.push(q.disposition);
  }
  if (DIRECTION_SQL[q.direction]) parts.push(DIRECTION_SQL[q.direction]);
  if (q.minDuration && Number(q.minDuration) > 0) { parts.push("billsec >= ?"); args.push(Number(q.minDuration)); }
  if (q.hideSystem !== "0") parts.push("dst NOT IN ('h','t','i') AND lastapp NOT IN ('Hangup')");
  return { sql: parts.join(" AND "), args };
}

const directionOf = (r) => {
  const ext = /^(SIP|PJSIP|IAX2)\/\d{2,6}-/;
  const fromExt = ext.test(r.channel || "");
  const toExt = ext.test(r.dstchannel || "");
  if (!fromExt && !/^Local\//.test(r.channel || "")) return "inbound";
  if (fromExt && (toExt || (!r.dstchannel && String(r.dst).length <= 6))) return "internal";
  if (fromExt) return "outbound";
  return "other";
};

export async function listCdr(q) {
  const cols = await getColumns();
  const { sql, args } = where(q);
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const extra = ["recordingfile", "did", "cnum", "cnam", "linkedid", "userfield"].filter((c) => cols.has(c));
  const sel = ["calldate", "clid", "src", "dst", "dcontext", "channel", "dstchannel", "lastapp", "lastdata", "duration", "billsec", "disposition", "uniqueid", ...extra]
    .filter((c) => cols.has(c)).map((c) => "`" + c + "`").join(", ");
  const sort = q.sort === "billsec" ? "billsec" : q.sort === "duration" ? "duration" : "calldate";
  const dir = q.order === "asc" ? "ASC" : "DESC";
  const p = await getPool();
  const [[rows], [[count]]] = await Promise.all([
    p.query(`SELECT ${sel} FROM ${table()} WHERE ${sql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`, [...args, limit, offset]),
    p.query(`SELECT count(*) AS n FROM ${table()} WHERE ${sql}`, args),
  ]);
  const tpl = settings().dial.recordingUrl;
  return {
    total: Number(count.n),
    rows: rows.map((r) => ({
      ...r, direction: directionOf(r),
      recordingUrl: tpl && r.recordingfile ? tpl.replace("{recordingfile}", encodeURIComponent(r.recordingfile))
        .replace("{date}", String(r.calldate).slice(0, 10).replace(/-/g, "/")) : "",
    })),
  };
}

export async function cdrStats(q) {
  const { sql, args } = where(q);
  const p = await getPool();
  const t = table();
  const peerExpr = (col) => `SUBSTRING_INDEX(SUBSTRING_INDEX(${col}, '-', 1), '/', -1)`;
  const [[[totals]], [byDay], [byHour], [outExt], [inExt], [topNumbers]] = await Promise.all([
    p.query(`SELECT count(*) AS total,
        SUM(disposition='ANSWERED') AS answered, SUM(disposition='NO ANSWER') AS noAnswer,
        SUM(disposition='BUSY') AS busy, SUM(disposition IN ('FAILED','CONGESTION')) AS failed,
        COALESCE(SUM(billsec),0) AS talk, COALESCE(AVG(CASE WHEN disposition='ANSWERED' THEN billsec END),0) AS avgTalk,
        COALESCE(MAX(billsec),0) AS maxTalk,
        SUM(${DIRECTION_SQL.inbound}) AS inbound, SUM(${DIRECTION_SQL.outbound}) AS outbound, SUM(${DIRECTION_SQL.internal}) AS internal
      FROM ${t} WHERE ${sql}`, args),
    p.query(`SELECT DATE_FORMAT(calldate, '%Y-%m-%d') AS day, count(*) AS total, SUM(disposition='ANSWERED') AS answered,
        COALESCE(SUM(billsec),0) AS talk FROM ${t} WHERE ${sql} GROUP BY day ORDER BY day LIMIT 400`, args),
    p.query(`SELECT HOUR(calldate) AS hour, count(*) AS total, SUM(disposition='ANSWERED') AS answered
      FROM ${t} WHERE ${sql} GROUP BY hour ORDER BY hour`, args),
    p.query(`SELECT ${peerExpr("channel")} AS ext, count(*) AS total, SUM(disposition='ANSWERED') AS answered, COALESCE(SUM(billsec),0) AS talk
      FROM ${t} WHERE ${sql} AND channel REGEXP ${EXT_CH} GROUP BY ext`, args),
    p.query(`SELECT ${peerExpr("dstchannel")} AS ext, count(*) AS total, SUM(disposition='ANSWERED') AS answered, COALESCE(SUM(billsec),0) AS talk
      FROM ${t} WHERE ${sql} AND dstchannel REGEXP ${EXT_CH} GROUP BY ext`, args),
    p.query(`SELECT src AS number, count(*) AS total, COALESCE(SUM(billsec),0) AS talk FROM ${t}
      WHERE ${sql} AND ${DIRECTION_SQL.inbound} AND src <> '' GROUP BY src ORDER BY total DESC LIMIT 10`, args),
  ]);
  const TEXT = new Set(["number", "ext", "day"]);
  const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, !TEXT.has(k) && typeof v === "string" && /^[\d.]+$/.test(v) ? Number(v) : v ?? 0]));
  const exts = new Map();
  for (const [rows, kind] of [[outExt, "out"], [inExt, "in"]]) for (const r of rows) {
    const e = exts.get(r.ext) || { ext: r.ext, outTotal: 0, outAnswered: 0, outTalk: 0, inTotal: 0, inAnswered: 0, inTalk: 0 };
    e[`${kind}Total`] = Number(r.total); e[`${kind}Answered`] = Number(r.answered); e[`${kind}Talk`] = Number(r.talk);
    exts.set(r.ext, e);
  }
  return {
    totals: num(totals),
    byDay: byDay.map(num),
    byHour: byHour.map(num),
    byExtension: [...exts.values()].sort((a, b) => b.inTotal + b.outTotal - a.inTotal - a.outTotal),
    topNumbers: topNumbers.map(num),
  };
}

/** Rows for CSV export (max 50k). */
export async function exportCdr(q) {
  const { sql, args } = where(q);
  const [rows] = await (await getPool()).query(
    `SELECT calldate, src, dst, clid, channel, dstchannel, disposition, duration, billsec, uniqueid FROM ${table()}
     WHERE ${sql} ORDER BY calldate DESC LIMIT 50000`, args);
  return rows.map((r) => ({ ...r, direction: directionOf(r) }));
}
