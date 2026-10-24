// One long-lived SSH connection per PBX, shared by server monitoring (exec) and recordings (SFTP),
// so frequent samples don't open a new SSH login (and a /var/log/secure entry) every few seconds.
import { Client as SshClient } from "ssh2";

export class SshConnection {
  /** cfg: () => ssh2 connect options (throws when SSH is not configured) */
  constructor(cfg) {
    this.cfg = cfg;
    this.conn = null;
    this.key = "";
    this.connecting = null;
    this.sftpHandle = null;
  }

  client() {
    const opts = this.cfg();
    const key = JSON.stringify(opts);
    if (this.conn && key === this.key) return Promise.resolve(this.conn);
    if (this.connecting && key === this.key) return this.connecting;
    this.reset();
    this.key = key;
    this.connecting = new Promise((resolve, reject) => {
      const c = new SshClient();
      c.once("ready", () => { this.connecting = null; this.conn = c; resolve(c); });
      c.once("error", (err) => { if (this.conn === c || this.connecting) { this.connecting = null; this.conn = null; } reject(new Error(`SSH: ${err.message}`)); });
      c.on("close", () => { if (this.conn === c) { this.conn = null; this.sftpHandle = null; } });
      c.connect({ ...opts, readyTimeout: 10000, keepaliveInterval: 20000, keepaliveCountMax: 3 });
    });
    return this.connecting;
  }

  /** Run a command; resolves stdout. */
  async exec(command, timeout = 15000) {
    const c = await this.client();
    return new Promise((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error("فرمان SSH پاسخ نداد (timeout)")), timeout);
      c.exec(command, (err, stream) => {
        if (err) { clearTimeout(t); return reject(new Error(`SSH: ${err.message}`)); }
        stream.on("data", (d) => { out += d; }).stderr.on("data", () => {});
        stream.on("close", () => { clearTimeout(t); resolve(out); });
      });
    });
  }

  async sftp() {
    if (this.sftpHandle) return this.sftpHandle;
    const c = await this.client();
    this.sftpHandle = await new Promise((resolve, reject) => c.sftp((err, s) => (err ? reject(new Error(`SFTP: ${err.message}`)) : resolve(s))));
    this.sftpHandle.on("close", () => { this.sftpHandle = null; });
    return this.sftpHandle;
  }

  reset() {
    this.conn?.end();
    this.conn = null;
    this.sftpHandle = null;
    this.connecting = null;
    this.key = "";
  }
}
