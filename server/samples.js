// Concurrent-call samples: counted every 2 s and pushed live to dashboards; every 10 s the peak of that
// window is stored (kept 90 days) so short spikes still show on the longer charts.
import { pool } from "./db.js";

const TICK = 2000;
const STORE_EVERY = 5; // ticks → 10 s rows
const RANGES = { "10m": [600, 10], "1h": [3600, 30], "6h": [6 * 3600, 120], "24h": [86400, 300], "7d": [7 * 86400, 1800], "30d": [30 * 86400, 7200] }; // [span s, bucket s]
const KEYS = ["total", "inbound", "outbound", "internal", "ringing", "waiting", "online"];

/** onTick(sample) receives every live count: {t, total, inbound, outbound, internal, ringing, waiting, online}. */
export function startSampler(serverId, pbx, queues, onTick = () => {}) {
  let peak = null;
  let n = 0;
  const take = async () => {
    if (pbx.ami.status !== "connected") return;
    const c = { t: Date.now(), total: 0, inbound: 0, outbound: 0, internal: 0, ringing: 0 };
    for (const k of pbx.calls()) { c.total++; c[k.direction]++; if (k.ringing) c.ringing++; }
    c.waiting = queues.queues.reduce((s, q) => s + q.entries.length, 0);
    c.online = [...pbx.peers.values()].filter((p) => p.kind === "extension" && !["offline", "unreachable"].includes(p.status)).length;
    onTick(c);
    peak = peak ? Object.fromEntries(KEYS.map((k) => [k, k === "online" ? c[k] : Math.max(peak[k], c[k])])) : { ...c };
    if (++n % STORE_EVERY) return;
    const p = peak;
    peak = null;
    await pool.query(`INSERT INTO call_samples (server_id, at, total, inbound, outbound, internal, ringing, queue_waiting, online_exts)
      VALUES ($1, date_trunc('second', now()), $2,$3,$4,$5,$6,$7,$8) ON CONFLICT (server_id, at) DO NOTHING`,
      [serverId, p.total, p.inbound, p.outbound, p.internal, p.ringing, p.waiting, p.online]).catch(() => {});
  };
  const t = setInterval(take, TICK);
  return () => clearInterval(t);
}
setInterval(() => pool.query(`DELETE FROM call_samples WHERE at < now() - interval '90 days'`).catch(() => {}), 6 * 3600 * 1000);

/** Bucketed series: peak and average concurrent calls per bucket. */
export async function series(serverId, range) {
  const [span, bucket] = RANGES[range] || RANGES["6h"];
  const { rows } = await pool.query(`
    SELECT extract(epoch FROM date_bin($1::interval, at, 'epoch'::timestamptz))::bigint * 1000 AS t,
      max(total) AS peak, round(avg(total)::numeric, 2)::float AS avg,
      max(inbound) AS inbound, max(outbound) AS outbound, max(internal) AS internal,
      max(queue_waiting) AS waiting, round(avg(online_exts))::int AS online
    FROM call_samples WHERE server_id = $3 AND at > now() - $2::interval GROUP BY 1 ORDER BY 1`, [`${bucket} seconds`, `${span} seconds`, serverId]);
  return { range, bucket, span, points: rows.map((r) => ({ ...r, t: Number(r.t) })) };
}

/** Peak concurrent calls today and over the last 30 days. */
export async function peaks(serverId) {
  const { rows } = await pool.query(`
    SELECT (SELECT max(total) FROM call_samples WHERE server_id = $1 AND at >= date_trunc('day', now())) AS today,
           (SELECT at FROM call_samples WHERE server_id = $1 AND at >= date_trunc('day', now()) ORDER BY total DESC, at DESC LIMIT 1) AS today_at,
           (SELECT max(total) FROM call_samples WHERE server_id = $1 AND at > now() - interval '30 days') AS month`, [serverId]);
  return rows[0];
}
