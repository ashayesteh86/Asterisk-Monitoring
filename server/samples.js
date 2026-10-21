// Concurrent-call samples for the dashboard chart: one row every 10 s, kept 90 days.
import { pool } from "./db.js";

const EVERY = 10000;
const RANGES = { "1h": [3600, 30], "6h": [6 * 3600, 120], "24h": [86400, 300], "7d": [7 * 86400, 1800], "30d": [30 * 86400, 7200] }; // [span s, bucket s]

export function startSampler(serverId, pbx, queues) {
  const take = async () => {
    if (pbx.ami.status !== "connected") return;
    const calls = pbx.calls();
    const c = { total: 0, inbound: 0, outbound: 0, internal: 0, ringing: 0 };
    for (const k of calls) { c.total++; c[k.direction]++; if (k.ringing) c.ringing++; }
    const waiting = queues.queues.reduce((s, q) => s + q.entries.length, 0);
    const online = [...pbx.peers.values()].filter((p) => p.kind === "extension" && !["offline", "unreachable"].includes(p.status)).length;
    await pool.query(`INSERT INTO call_samples (server_id, at, total, inbound, outbound, internal, ringing, queue_waiting, online_exts)
      VALUES ($1, date_trunc('second', now()), $2,$3,$4,$5,$6,$7,$8) ON CONFLICT (server_id, at) DO NOTHING`,
      [serverId, c.total, c.inbound, c.outbound, c.internal, c.ringing, waiting, online]).catch(() => {});
  };
  const t = setInterval(take, EVERY);
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
