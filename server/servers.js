// One runtime per PBX server: its own AMI connection, live state, queue and system monitors, CDR source and sampler.
// All live changes are re-emitted on `hub` tagged with the server id.
import { EventEmitter } from "node:events";
import { AmiClient } from "./ami/client.js";
import { Pbx } from "./ami/pbx.js";
import { QueueMonitor } from "./ami/queues.js";
import { SystemMonitor } from "./system.js";
import { CdrSource } from "./cdr.js";
import { startSampler } from "./samples.js";
import { getServer, listServers } from "./db.js";

export const hub = new EventEmitter();
hub.setMaxListeners(0);

export class ServerRuntime {
  constructor(id) {
    this.id = id;
    this.cfg = () => getServer(id)?.config;
    this.ami = new AmiClient();
    this.pbx = new Pbx(this.ami, () => this.cfg().dial);
    this.queues = new QueueMonitor(this.ami);
    this.system = new SystemMonitor(this.ami, this.cfg);
    this.cdr = new CdrSource(this.cfg);
    this.stopSampler = startSampler(id, this.pbx, this.queues);
    this.pbx.on("change", (item) => hub.emit("change", id, item));
    this.queues.on("change", (item) => hub.emit("change", id, item));
    this.ami.on("status", () => hub.emit("status", id));
    this.apply();
  }

  get meta() { return getServer(this.id); }

  /** (Re)connect AMI with the stored settings; disabled servers stay disconnected. */
  apply() {
    const s = getServer(this.id);
    this.ami.configure(s?.enabled ? s.config.ami : null);
    this.system.schedule();
  }

  destroy() {
    this.stopSampler();
    this.system.destroy();
    clearInterval(this.queues.timer);
    this.pbx.stop();
    this.cdr.reset();
    this.ami.configure(null);
    this.ami.removeAllListeners();
    this.pbx.removeAllListeners();
    this.queues.removeAllListeners();
  }

  /** Short status for the server picker and overview. */
  status() {
    const s = getServer(this.id);
    return { id: this.id, name: s?.name || "", enabled: !!s?.enabled, ami: this.ami.info() };
  }
}

export const runtimes = new Map();

export function startAll() {
  for (const s of listServers()) if (!runtimes.has(s.id)) runtimes.set(s.id, new ServerRuntime(s.id));
}
export function addRuntime(id) {
  const rt = new ServerRuntime(id);
  runtimes.set(id, rt);
  hub.emit("status", id);
  return rt;
}
export function removeRuntime(id) {
  runtimes.get(id)?.destroy();
  runtimes.delete(id);
  hub.emit("status", id);
}
export const runtime = (id) => runtimes.get(Number(id)) || null;
