// Minimal Asterisk Manager Interface client: one TCP connection, auto-reconnect,
// promise-based actions and list actions (EventList start … Complete).
// Works with Asterisk 1.8/11 ("Response: Follows" command output) and 12+ ("Output:" lines).
import net from "node:net";
import { EventEmitter } from "node:events";

const CRLF = "\r\n";

/** Parse one AMI message block into an object. Repeated keys become arrays. */
export function parseMessage(block) {
  const msg = {};
  const lines = block.split(/\r?\n/);
  if (/^Response:\s*Follows/i.test(lines[0] || "")) {
    // Asterisk 1.8/11 Command output: header lines, then raw text, then --END COMMAND--
    msg.Response = "Follows";
    const out = [];
    for (const line of lines.slice(1)) {
      const kv = /^(ActionID|Privilege):\s?(.*)$/.exec(line);
      if (kv) msg[kv[1]] = kv[2];
      else if (line.trim() === "--END COMMAND--") break;
      else out.push(line);
    }
    msg.Output = out;
    return msg;
  }
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).replace(/^ /, "");
    if (key in msg) msg[key] = [].concat(msg[key], value);
    else msg[key] = value;
  }
  return msg;
}

/** Serialise an action. Array values are sent as repeated keys (e.g. Variable). */
export function buildAction(action) {
  let s = "";
  for (const [k, v] of Object.entries(action)) {
    if (v === undefined || v === null) continue;
    for (const item of [].concat(v)) s += `${k}: ${String(item).replace(/[\r\n]+/g, " ")}${CRLF}`;
  }
  return s + CRLF;
}

export class AmiClient extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.socket = null;
    this.buffer = "";
    this.pending = new Map(); // ActionID → {resolve, reject, timer, list, events}
    this.seq = 0;
    this.status = "disabled"; // disabled | connecting | connected | error
    this.lastError = "";
    this.banner = "";
    this.version = "";
    this.retryDelay = 2000;
    this.retryTimer = null;
    this.pingTimer = null;
  }

  configure(config) {
    this.config = config && config.host && config.username ? { port: 5038, ...config } : null;
    this.disconnect();
    if (this.config) this.connect();
    else this.setStatus("disabled", "");
  }

  setStatus(status, error = this.lastError) {
    this.status = status;
    this.lastError = error;
    this.emit("status", this.info());
  }

  info() {
    return { status: this.status, error: this.lastError, version: this.version, banner: this.banner,
      host: this.config?.host || "", port: this.config?.port || 5038 };
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (!this.config) return;
    const { host, port } = this.config;
    this.setStatus("connecting", "");
    this.buffer = "";
    this.banner = "";
    const socket = net.createConnection({ host, port: Number(port) });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 15000);
    socket.setTimeout(15000, () => socket.destroy(new Error("اتصال AMI پاسخ نمی‌دهد (timeout)")));
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => { this.lastError = err.message; });
    socket.on("close", () => this.onClose(socket));
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.removeAllListeners("close");
      s.destroy();
    }
    this.failPending(new Error("AMI disconnected"));
  }

  failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  onClose(socket) {
    if (socket !== this.socket) return;
    clearInterval(this.pingTimer);
    this.socket = null;
    this.failPending(new Error("AMI disconnected"));
    const wasConnected = this.status === "connected";
    this.setStatus("error", this.lastError || "اتصال AMI قطع شد");
    if (wasConnected) this.emit("disconnected");
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }

  onData(chunk) {
    this.buffer += chunk;
    if (!this.banner) {
      const nl = this.buffer.indexOf(CRLF);
      if (nl < 0) return;
      this.banner = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 2);
      this.login();
    }
    for (;;) {
      let end = this.buffer.indexOf(CRLF + CRLF);
      if (end < 0) break;
      // Legacy command output may contain blank lines: wait for its end marker
      if (/^Response:\s*Follows/i.test(this.buffer)) {
        const marker = this.buffer.indexOf("--END COMMAND--");
        if (marker < 0) break;
        end = this.buffer.indexOf(CRLF + CRLF, marker);
        if (end < 0) break;
      }
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 4);
      if (block.trim()) this.dispatch(parseMessage(block));
    }
  }

  async login() {
    try {
      const r = await this.send({ Action: "Login", Username: this.config.username, Secret: this.config.secret, Events: "on" }, 8000);
      if (r.Response !== "Success") throw new Error(r.Message || "ورود به AMI ناموفق بود");
      this.socket?.setTimeout(0);
      this.retryDelay = 2000;
      try {
        const s = await this.send({ Action: "CoreSettings" }, 8000);
        this.version = s.AsteriskVersion || "";
      } catch { this.version = ""; }
      if (!this.version) {
        const m = /Call Manager\/(\d+)/.exec(this.banner);
        this.version = m && Number(m[1]) >= 2 ? "13" : "11";
      }
      this.lastError = "";
      this.setStatus("connected", "");
      this.pingTimer = setInterval(() => this.send({ Action: "Ping" }, 10000).catch(() => this.socket?.destroy()), 20000);
      this.emit("connected", this.info());
    } catch (err) {
      this.lastError = err.message === "AMI disconnected" ? "ورود به AMI ناموفق بود (نام کاربری/رمز یا permit)" : err.message;
      this.socket?.destroy();
    }
  }

  /** Major Asterisk version as a number (11, 13, 16 …). */
  get major() {
    const m = /^(?:\D*)(\d+)(?:\.(\d+))?/.exec(this.version || "");
    if (!m) return 13;
    return Number(m[1]) === 1 ? 1 : Number(m[1]); // 1.8 → 1 (legacy)
  }

  get legacy() { return this.major < 12; }

  dispatch(msg) {
    const id = msg.ActionID;
    const p = id && this.pending.get(id);
    if (p) {
      if (msg.Event) {
        if (p.list) {
          if (msg.EventList === "Complete" || /Complete$/.test(msg.Event)) return this.finish(id, { ...p.response, events: p.events, complete: msg });
          p.events.push(msg);
          return;
        }
      } else if (msg.Response) {
        if (p.list && msg.Response === "Success") { p.response = msg; return; }
        return this.finish(id, p.list ? { ...msg, events: [] } : msg);
      }
    }
    if (msg.Event) this.emit("event", msg);
  }

  finish(id, value) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(value);
  }

  send(action, timeout = 10000, list = false) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error("AMI متصل نیست"));
      const ActionID = `p${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(ActionID);
        reject(new Error(`پاسخی از AMI برای ${action.Action} دریافت نشد`));
      }, timeout);
      this.pending.set(ActionID, { resolve, reject, timer, list, events: [], response: null });
      this.socket.write(buildAction({ ...action, ActionID }));
    });
  }

  /** Run an action once logged in. */
  action(action, timeout) {
    if (this.status !== "connected") return Promise.reject(new Error("AMI متصل نیست"));
    return this.send(action, timeout);
  }

  /** Run a list action and collect its events. Resolves {Response, events}. */
  list(action, timeout = 20000) {
    if (this.status !== "connected") return Promise.reject(new Error("AMI متصل نیست"));
    return this.send(action, timeout, true);
  }

  /** CLI command; resolves the output lines for both legacy and modern Asterisk. */
  async command(cmd, timeout = 15000) {
    const r = await this.action({ Action: "Command", Command: cmd }, timeout);
    if (r.Response === "Error") throw new Error(r.Message || r.Output || "Command failed");
    const out = r.Output === undefined ? [] : [].concat(r.Output);
    return out.flatMap((l) => String(l).split(/\r?\n/));
  }
}

/** One-off connection for the settings page "test" button. */
export function testAmi(config, timeout = 8000) {
  return new Promise((resolve) => {
    const c = new AmiClient();
    c.retryDelay = 1e9;
    const done = (result) => { clearTimeout(t); c.configure(null); resolve(result); };
    const t = setTimeout(() => done({ ok: false, error: c.lastError || "اتصال برقرار نشد (timeout)" }), timeout);
    c.on("connected", (info) => done({ ok: true, version: info.version, banner: info.banner }));
    c.on("status", (s) => { if (s.status === "error") done({ ok: false, error: s.error }); });
    c.configure(config);
  });
}
