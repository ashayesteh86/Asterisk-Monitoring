// Asterisk server health: CPU, RAM, swap, disks, uptime, load, service processes, Asterisk core status.
// Host metrics come from one shell snippet, run either through AMI (Getvar SHELL(), needs func_shell and,
// on Asterisk 12+, live_dangerously=yes) or over SSH. Asterisk's own numbers always come from AMI.
import { EventEmitter } from "node:events";
import { Client as SshClient } from "ssh2";
import { settings } from "./db.js";

const HISTORY = 6 * 3600; // seconds of samples kept in memory

/** Shell snippet: no parentheses or commas (it goes inside SHELL()), one "key=value" per line, joined by ";". */
export function metricsScript(services) {
  const names = [...new Set(services.flatMap((s) => s.split("|")))].filter((n) => /^[A-Za-z0-9_.-]+$/.test(n));
  return [
    "{ echo up=`cut -d' ' -f1 /proc/uptime`",
    "echo load=`cut -d' ' -f1-3 /proc/loadavg`",
    "echo ncpu=`grep -c ^processor /proc/cpuinfo`",
    "echo host=`uname -n` `uname -r`",
    "head -1 /proc/stat",
    "sleep 1",
    "head -1 /proc/stat",
    "grep -E '^MemTotal:|^MemFree:|^MemAvailable:|^Buffers:|^Cached:|^SwapTotal:|^SwapFree:' /proc/meminfo | awk '{print $1$2}'",
    "df -Pk | awk 'NR>1 && $1 ~ /^\\/dev/ {print \"disk=\"$6\":\"$2\":\"$3}'",
    `for p in ${names.join(" ")}; do pidof $p >/dev/null && echo svc=$p:up || echo svc=$p:down; done`,
    "ps -C asterisk -o pcpu= -o rss= | head -1 | awk '{print \"astp=\"$1\":\"$2}'",
    "; } 2>/dev/null | tr '\\n' ';'",
  ].join("; ").replace("; ; }", "; }");
}

export function parseMetrics(text, services) {
  const out = { disks: [], services: [], cpu: null };
  const cpuLines = [];
  const mem = {};
  for (const raw of String(text).split(/[;\n]/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("cpu ")) { cpuLines.push(line.split(/\s+/).slice(1).map(Number)); continue; }
    const m = /^(\w+)[=:](.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "up") out.uptime = Math.round(Number(v));
    else if (k === "load") out.load = v.split(/\s+/).map(Number);
    else if (k === "ncpu") out.cpus = Number(v);
    else if (k === "host") out.host = v.trim();
    else if (k === "disk") { const [mount, total, used] = v.split(":"); out.disks.push({ mount, total: Number(total) * 1024, used: Number(used) * 1024 }); }
    else if (k === "svc") { const [name, st] = v.split(":"); out.services.push({ name, up: st === "up" }); }
    else if (k === "astp") { const [pcpu, rss] = v.split(":"); out.asteriskProcess = { cpu: Number(pcpu), rss: Number(rss) * 1024 }; }
    else if (/^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree)$/.test(k)) mem[k] = Number(v.replace(/\D/g, "")) * 1024;
  }
  if (cpuLines.length >= 2) {
    const [a, b] = cpuLines;
    const idle = (x) => x[3] + (x[4] || 0);
    const total = (x) => x.reduce((s, n) => s + (n || 0), 0);
    const dt = total(b) - total(a);
    out.cpu = dt > 0 ? Math.round(1000 * (1 - (idle(b) - idle(a)) / dt)) / 10 : 0;
  }
  if (mem.MemTotal) {
    const available = mem.MemAvailable ?? mem.MemFree + (mem.Buffers || 0) + (mem.Cached || 0);
    out.memory = { total: mem.MemTotal, used: mem.MemTotal - available, available };
    out.swap = { total: mem.SwapTotal || 0, used: (mem.SwapTotal || 0) - (mem.SwapFree || 0) };
  }
  // collapse "mysqld|mariadbd" alternatives into one entry
  out.services = services.map((spec) => {
    const alts = spec.split("|");
    const hit = out.services.filter((s) => alts.includes(s.name));
    const up = hit.find((s) => s.up);
    return { name: up?.name || alts[0], label: alts.join(" / "), up: !!up, known: hit.length > 0 };
  });
  return out;
}

const sysinfoNum = (lines, label) => {
  const l = lines.find((x) => x.trim().startsWith(label));
  const m = l && /:\s*(\d+)/.exec(l);
  return m ? Number(m[1]) : null;
};

export class SystemMonitor extends EventEmitter {
  constructor(ami) {
    super();
    this.ami = ami;
    this.latest = null;
    this.history = [];
    this.lastError = "";
    this.timer = null;
    this.busy = false;
    this.schedule();
  }

  schedule() {
    clearInterval(this.timer);
    const s = settings().system;
    if (s.method === "off") return;
    const sec = Math.min(Math.max(Number(s.interval) || 15, 5), 300);
    this.timer = setInterval(() => this.sample().catch(() => {}), sec * 1000);
    setTimeout(() => this.sample().catch(() => {}), 2000);
  }

  services() {
    return String(settings().system.services || "").split(/[,\s]+/).filter(Boolean).slice(0, 15);
  }

  async hostMetrics() {
    const s = settings().system;
    const script = metricsScript(this.services());
    if (s.method === "ssh") return parseMetrics(await sshExec(s, script.replace(" | tr '\\n' ';'", "")), this.services());
    if (s.method !== "ami") return null;
    const r = await this.ami.action({ Action: "Getvar", Variable: `SHELL(${script})` }, 15000);
    if (r.Response !== "Success" || !r.Value) {
      throw new Error(/external source|live_dangerously/i.test(r.Message || "")
        ? "استریسک اجرای SHELL از AMI را مسدود کرده است: در asterisk.conf بخش [options] مقدار live_dangerously = yes بگذارید، یا روش SSH را انتخاب کنید"
        : `اجرای SHELL از طریق AMI ممکن نشد (${r.Message || "خروجی خالی"}) — ماژول func_shell را بررسی کنید یا روش SSH را انتخاب کنید`);
    }
    return parseMetrics(r.Value, this.services());
  }

  async asteriskStatus() {
    if (this.ami.status !== "connected") return null;
    const out = { version: this.ami.version };
    try {
      const c = await this.ami.action({ Action: "CoreStatus" });
      if (c.Response === "Success") Object.assign(out, {
        startup: `${c.CoreStartupDate || ""} ${c.CoreStartupTime || ""}`.trim(), reload: `${c.CoreReloadDate || ""} ${c.CoreReloadTime || ""}`.trim(),
        currentCalls: Number(c.CoreCurrentCalls) || 0,
      });
    } catch { /* ignore */ }
    try {
      const lines = await this.ami.command("core show uptime seconds");
      const up = lines.find((l) => /System uptime/i.test(l));
      const rl = lines.find((l) => /Last reload/i.test(l));
      out.uptime = up ? Number(/(\d+)/.exec(up)?.[1]) : null;
      out.sinceReload = rl ? Number(/(\d+)/.exec(rl)?.[1]) : null;
    } catch { /* ignore */ }
    try {
      const lines = await this.ami.command("core show sysinfo");
      const kib = (label) => { const n = sysinfoNum(lines, label); return n === null ? null : n * 1024; };
      out.sysinfo = { totalRam: kib("Total RAM"), freeRam: kib("Free RAM"), bufferRam: kib("Buffer RAM"),
        totalSwap: kib("Total Swap Space"), freeSwap: kib("Free Swap Space"), processes: sysinfoNum(lines, "Number of Processes") };
      if (out.sysinfo.totalRam === null) out.sysinfo = null;
    } catch { out.sysinfo = null; }
    try {
      const lines = await this.ami.command("core show channels count");
      out.processed = Number(/(\d+)\s+calls? processed/i.exec(lines.join(" "))?.[1]) || null;
    } catch { /* ignore */ }
    try {
      const lines = await this.ami.command("module show like chan_");
      out.modules = lines.map((l) => /^(chan_\w+\.so)\s+(.*?)\s{2,}\d+\s+(\w+)/.exec(l)).filter(Boolean).map((m) => ({ name: m[1], description: m[2].trim(), status: m[3] }));
    } catch { /* ignore */ }
    return out;
  }

  async sample() {
    if (this.busy) return this.latest;
    this.busy = true;
    try {
      const [host, asterisk] = await Promise.all([
        this.hostMetrics().then((h) => { this.lastError = ""; return h; }, (e) => { this.lastError = e.message; return null; }),
        this.asteriskStatus(),
      ]);
      // RAM fallback from Asterisk's own sysinfo when shell metrics are unavailable
      let memory = host?.memory;
      if (!memory && asterisk?.sysinfo) {
        const si = asterisk.sysinfo;
        memory = { total: si.totalRam, used: si.totalRam - si.freeRam - (si.bufferRam || 0), available: si.freeRam + (si.bufferRam || 0), approximate: true };
      }
      const swap = host?.swap || (asterisk?.sysinfo ? { total: asterisk.sysinfo.totalSwap, used: asterisk.sysinfo.totalSwap - asterisk.sysinfo.freeSwap } : null);
      this.latest = { at: Date.now(), method: settings().system.method, error: this.lastError, host, asterisk, memory, swap };
      this.history.push({ at: this.latest.at, cpu: host?.cpu ?? null, mem: memory ? Math.round((memory.used / memory.total) * 1000) / 10 : null, load: host?.load?.[0] ?? null });
      const cutoff = Date.now() - HISTORY * 1000;
      while (this.history.length && this.history[0].at < cutoff) this.history.shift();
      this.emit("sample", this.latest);
      return this.latest;
    } finally { this.busy = false; }
  }
}

export function sshExec(cfg, command, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let out = "";
    const t = setTimeout(() => { conn.end(); reject(new Error("اتصال SSH پاسخ نداد (timeout)")); }, timeout);
    conn.on("ready", () => conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(t); conn.end(); return reject(err); }
      stream.on("data", (d) => { out += d; }).stderr.on("data", () => {});
      stream.on("close", () => { clearTimeout(t); conn.end(); resolve(out); });
    }));
    conn.on("error", (e) => { clearTimeout(t); reject(new Error(`SSH: ${e.message}`)); });
    conn.connect({ host: cfg.sshHost || settings().ami.host, port: Number(cfg.sshPort) || 22, username: cfg.sshUser,
      password: cfg.sshPassword || undefined, privateKey: cfg.sshKey || undefined, readyTimeout: 10000 });
  });
}
