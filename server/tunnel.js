// Local TCP port forwarded over SSH, so the panel can reach the PBX's MySQL without opening 3306.
// One SSH connection is shared by all forwarded sockets and reopened on demand after it drops.
import net from "node:net";
import { Client as SshClient } from "ssh2";

export class SshTunnel {
  /** ssh: {host, port, username, password?, privateKey?}; target: {host, port} as seen from the SSH server */
  constructor(ssh, target) {
    this.ssh = ssh;
    this.target = target;
    this.client = null;
    this.connecting = null;
    this.server = null;
    this.port = 0;
  }

  /** Start the local listener; resolves the local port to connect MySQL to. */
  async open() {
    if (this.port) return this.port;
    this.server = net.createServer((sock) => this.forward(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  sshClient() {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const c = new SshClient();
      const fail = (err) => { this.connecting = null; this.client = null; reject(new Error(`SSH: ${err.message}`)); };
      c.once("ready", () => { this.connecting = null; this.client = c; resolve(c); });
      c.once("error", fail);
      c.on("close", () => { if (this.client === c) this.client = null; });
      c.connect({ ...this.ssh, readyTimeout: 10000, keepaliveInterval: 20000 });
    });
    return this.connecting;
  }

  async forward(sock) {
    sock.on("error", () => {});
    try {
      const c = await this.sshClient();
      c.forwardOut("127.0.0.1", 0, this.target.host, Number(this.target.port), (err, stream) => {
        if (err) { this.lastError = err.reason === 1 ? "administratively prohibited" : err.message; return sock.destroy(); }
        stream.on("error", () => sock.destroy());
        sock.pipe(stream).pipe(sock);
      });
    } catch (err) {
      this.lastError = err.message;
      sock.destroy();
    }
  }

  /** Fails fast with the real SSH error instead of MySQL's generic "connection lost". */
  async check() {
    await this.sshClient();
  }

  close() {
    this.server?.close();
    this.client?.end();
    this.server = null;
    this.client = null;
    this.port = 0;
  }
}

/** SSH settings for the PBX (shared with server monitoring); throws a Persian error when incomplete. */
export function sshConfigFrom(system, amiHost) {
  if (!system.sshUser || !(system.sshPassword || system.sshKey)) {
    throw Object.assign(new Error("برای اتصال از طریق SSH، ابتدا نام کاربری و رمز (یا کلید) SSH را در «تنظیمات › مانیتورینگ سرور» وارد و ذخیره کنید"), { status: 400 });
  }
  return {
    host: system.sshHost || amiHost, port: Number(system.sshPort) || 22, username: system.sshUser,
    password: system.sshPassword || undefined, privateKey: system.sshKey || undefined,
  };
}
