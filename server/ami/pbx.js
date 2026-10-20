// Live PBX state built from AMI: peers (extensions + trunks), channels, trunk registrations, DAHDI spans.
// Event handling covers Asterisk 1.8/11 (Bridge, Dial SubEvent, Hold Status) and 12+
// (BridgeEnter/Leave, DialBegin, Hold/Unhold). A periodic CoreShowChannels resync corrects any drift.
import { EventEmitter } from "node:events";
import { parsePhoneModel } from "./phone-model.js";
import { matchDialplan } from "../util.js";

const LIST_EVENTS = { peers: 60000, channels: 15000, registry: 30000, details: 600000 };

/** "SIP/101-0000001a" → {tech:"SIP", peer:"101"}; "DAHDI/i1/0912…-5" → {tech:"DAHDI", peer:"DAHDI"} */
export function parseChannel(name) {
  const m = /^([A-Za-z0-9]+)\/(.+)$/.exec(name || "");
  if (!m) return { tech: "", peer: "" };
  const tech = m[1].toUpperCase() === "PJSIP" ? "PJSIP" : m[1].toUpperCase() === "SIP" ? "SIP" : m[1];
  if (/^DAHDI$/i.test(tech)) return { tech: "DAHDI", peer: "DAHDI" };
  if (/^Local$/i.test(tech)) return { tech: "Local", peer: "" };
  const rest = m[2].replace(/<ZOMBIE>|<MASQ>/g, "");
  const peer = rest.replace(/-[0-9a-f]{8}(?:;\d)?$/i, "").replace(/-\d+$/, "").split("/")[0];
  return { tech, peer };
}

const clean = (v) => (!v || v === "<unknown>" || v === "<unknown> <unknown>" ? "" : String(v));

function parseDuration(d) {
  if (!d) return 0;
  if (/^\d+$/.test(d)) return Number(d);
  const p = String(d).split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0;
}

function parseSipStatus(s) {
  const str = String(s || "");
  const lat = /\((\d+)\s*ms\)/.exec(str);
  if (/^OK/i.test(str)) return { status: "online", latency: lat ? Number(lat[1]) : null };
  if (/LAGGED/i.test(str)) return { status: "lagged", latency: lat ? Number(lat[1]) : null };
  if (/UNREACHABLE/i.test(str)) return { status: "unreachable", latency: null };
  if (/Unmonitored/i.test(str)) return { status: "unmonitored", latency: null };
  return { status: "offline", latency: null };
}

export class Pbx extends EventEmitter {
  constructor(ami, getSettings) {
    super();
    this.ami = ami;
    this.getSettings = getSettings;
    this.peers = new Map();
    this.channels = new Map();
    this.registrations = [];
    this.dahdi = [];
    this.timers = [];
    this.detailQueue = new Set();
    this.detailRunning = false;
    ami.on("connected", () => this.start());
    ami.on("disconnected", () => this.stop());
    ami.on("status", (s) => this.emit("change", { type: "ami", data: s }));
    ami.on("event", (e) => this.onEvent(e));
  }

  isExtension(name) {
    return matchDialplan(this.getSettings().extensionPattern || "_XX, _XXX, _XXXX, _XXXXX", name);
  }

  /** Live calls grouped by bridge, as [{channels, direction, ringing}] (Local channels ignored). */
  calls() {
    const seen = new Set();
    const out = [];
    const isTrunk = (c) => c.tech === "DAHDI" || (c.peer && this.peers.get(c.peer)?.kind === "trunk");
    const isExt = (c) => c.peer && this.peers.get(c.peer)?.kind === "extension";
    for (const c of [...this.channels.values()].sort((a, b) => a.startedAt - b.startedAt)) {
      if (seen.has(c.name) || c.tech === "Local") continue;
      const group = [c];
      seen.add(c.name);
      for (let i = 0; i < group.length; i++) for (const n of group[i].bridged) {
        const o = this.channels.get(n);
        if (o && !seen.has(n) && o.tech !== "Local") { seen.add(n); group.push(o); }
      }
      const exts = group.filter(isExt);
      const trunk = group.some(isTrunk);
      out.push({
        channels: group, exts: exts.map((e) => e.peer),
        direction: !trunk ? "internal" : exts.some((e) => e.direction === "out") ? "outbound" : "inbound",
        ringing: !group.some((x) => x.state === 6 && x.bridged.length),
      });
    }
    return out;
  }

  /** Re-apply the extension pattern after the dial settings change. */
  reclassify() {
    for (const p of this.peers.values()) {
      const kind = this.isExtension(p.name) ? "extension" : "trunk";
      if (kind !== p.kind) this.upsertPeer(p.name, { kind });
    }
  }

  snapshot() {
    return {
      ami: this.ami.info(),
      peers: [...this.peers.values()],
      channels: [...this.channels.values()],
      registrations: this.registrations,
      dahdi: this.dahdi,
    };
  }

  start() {
    this.stop();
    this.peers.clear();
    this.channels.clear();
    this.emit("change", { type: "reset" });
    this.syncPeers().then(() => this.queueAllDetails()).catch(() => {});
    this.syncChannels().catch(() => {});
    this.syncRegistry().catch(() => {});
    this.syncDahdi().catch(() => {});
    this.timers.push(setInterval(() => this.syncPeers().catch(() => {}), LIST_EVENTS.peers));
    this.timers.push(setInterval(() => this.syncChannels().catch(() => {}), LIST_EVENTS.channels));
    this.timers.push(setInterval(() => { this.syncRegistry().catch(() => {}); this.syncDahdi().catch(() => {}); }, LIST_EVENTS.registry));
    this.timers.push(setInterval(() => this.queueAllDetails(), LIST_EVENTS.details));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.detailQueue.clear();
  }

  // ---------- peers ----------
  upsertPeer(name, patch) {
    const prev = this.peers.get(name) || {
      name, tech: "SIP", kind: this.isExtension(name) ? "extension" : "trunk",
      callerName: "", ip: "", port: "", status: "offline", latency: null, userAgent: "",
      phone: parsePhoneModel(""), context: "", dynamic: true, description: "", updatedAt: 0,
    };
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    if (patch.userAgent !== undefined) next.phone = parsePhoneModel(patch.userAgent);
    const changed = JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 });
    this.peers.set(name, next);
    if (changed) this.emit("change", { type: "peer", data: next });
    return next;
  }

  async syncPeers() {
    const seen = new Set();
    try {
      const r = await this.ami.list({ Action: "SIPpeers" });
      for (const e of r.events) {
        if (e.Event !== "PeerEntry" || !e.ObjectName) continue;
        seen.add(e.ObjectName);
        const st = parseSipStatus(e.Status);
        this.upsertPeer(e.ObjectName, {
          tech: "SIP", ip: e.IPaddress && e.IPaddress !== "-none-" ? e.IPaddress : "", port: e.IPport && e.IPport !== "0" ? e.IPport : "",
          status: e.IPaddress && e.IPaddress !== "-none-" && st.status === "offline" ? "unmonitored" : st.status,
          latency: st.latency, dynamic: e.Dynamic === "yes", description: e.Description || "",
        });
      }
    } catch { /* chan_sip not loaded */ }
    if (!this.ami.legacy) {
      try {
        const r = await this.ami.list({ Action: "PJSIPShowEndpoints" });
        for (const e of r.events) {
          if (e.Event !== "EndpointList" || !e.ObjectName) continue;
          seen.add(e.ObjectName);
          const unavailable = /Unavailable|Invalid/i.test(e.DeviceState || "");
          this.upsertPeer(e.ObjectName, { tech: "PJSIP", status: unavailable ? "offline" : (this.peers.get(e.ObjectName)?.status === "offline" ? "online" : this.peers.get(e.ObjectName)?.status || "online") });
        }
        await this.syncPjsipContacts();
      } catch { /* res_pjsip not loaded */ }
    }
    for (const name of this.peers.keys()) {
      if (!seen.has(name)) { this.peers.delete(name); this.emit("change", { type: "peerDel", name }); }
    }
  }

  async syncPjsipContacts() {
    const r = await this.ami.list({ Action: "PJSIPShowContacts" });
    const byEndpoint = new Map();
    for (const e of r.events) {
      if (e.Event !== "ContactList") continue;
      const ep = e.Endpoint || e.EndpointName || String(e.Aor || "").split(",")[0];
      if (!ep || byEndpoint.has(ep) && /Avail/i.test(byEndpoint.get(ep).Status)) continue;
      byEndpoint.set(ep, e);
    }
    for (const [ep, e] of byEndpoint) {
      if (!this.peers.has(ep)) continue;
      const addr = /@([^:;>]+)(?::(\d+))?/.exec(e.Uri || e.URI || "") || [];
      const rtt = Number(e.RoundtripUsec);
      this.upsertPeer(ep, {
        ip: e.ViaAddress?.split(":")[0] || addr[1] || "", port: addr[2] || "",
        userAgent: e.UserAgent || this.peers.get(ep).userAgent,
        status: /Unavail|Unreach/i.test(e.Status) ? "unreachable" : "online",
        latency: rtt > 0 ? Math.round(rtt / 1000) : null,
      });
    }
  }

  queueAllDetails() {
    for (const p of this.peers.values()) if (p.tech === "SIP") this.detailQueue.add(p.name);
    this.runDetails();
  }

  queueDetail(name) {
    this.detailQueue.add(name);
    clearTimeout(this.detailDebounce);
    this.detailDebounce = setTimeout(() => this.runDetails(), 500);
  }

  /** SIPshowpeer for each peer, a few at a time, to learn User-Agent / CallerID / context. */
  async runDetails() {
    if (this.detailRunning) return;
    this.detailRunning = true;
    try {
      while (this.detailQueue.size && this.ami.status === "connected") {
        const batch = [...this.detailQueue].slice(0, 4);
        batch.forEach((n) => this.detailQueue.delete(n));
        await Promise.all(batch.map((n) => this.peerDetail(n).catch(() => {})));
      }
    } finally { this.detailRunning = false; }
  }

  async peerDetail(name) {
    const p = this.peers.get(name);
    if (!p || p.tech !== "SIP") return;
    const r = await this.ami.action({ Action: "SIPshowpeer", Peer: name });
    if (r.Response !== "Success") return;
    const cid = /^"?([^"<]*)"?\s*<([^>]*)>/.exec(r.Callerid || "");
    const st = parseSipStatus(r.Status);
    this.upsertPeer(name, {
      userAgent: r["SIP-Useragent"] || "",
      callerName: cid ? cid[1].trim() : "",
      context: r.Context || "",
      ip: r["Address-IP"] && r["Address-IP"] !== "(null)" ? r["Address-IP"] : p.ip,
      status: st.status === "offline" && p.status !== "offline" ? p.status : st.status,
      latency: st.latency ?? p.latency,
      host: r.ToHost || r["Default-addr-IP"] || "",
      regContact: r["Reg-Contact"] || "",
      nat: r.Nat || r["SIP-NatSupport"] || "",
      codecs: r.Codecs || "",
    });
  }

  // ---------- registrations / DAHDI ----------
  async syncRegistry() {
    const regs = [];
    try {
      const r = await this.ami.list({ Action: "SIPshowregistry" });
      for (const e of r.events) if (e.Event === "RegistryEntry")
        regs.push({ tech: "SIP", host: e.Host, port: e.Port, username: e.Username, domain: e.Domain || e.Host, state: e.State, refresh: e.Refresh, time: e.RegistrationTime });
    } catch { /* ignore */ }
    if (!this.ami.legacy) {
      try {
        const r = await this.ami.list({ Action: "PJSIPShowRegistrationsOutbound" });
        for (const e of r.events) if (e.Event === "OutboundRegistrationDetail")
          regs.push({ tech: "PJSIP", name: e.ObjectName, host: e.ServerUri, username: e.ClientUri, state: e.Status, endpoint: e.Endpoint || e.OutboundAuth || "" });
      } catch { /* ignore */ }
    }
    if (JSON.stringify(regs) !== JSON.stringify(this.registrations)) {
      this.registrations = regs;
      this.emit("change", { type: "registrations", data: regs });
    }
  }

  async syncDahdi() {
    let list = [];
    try {
      const r = await this.ami.list({ Action: "DAHDIShowChannels" });
      list = r.events.filter((e) => e.Event === "DAHDIShowChannels").map((e) => ({
        channel: e.DAHDIChannel, signalling: e.Signalling || e.SignallingCode, context: e.Context,
        dnd: e.DND === "Enabled", alarm: e.Alarm || "", active: !!e.Channel && e.Channel !== "",
      }));
    } catch { /* no DAHDI */ }
    if (JSON.stringify(list) !== JSON.stringify(this.dahdi)) {
      this.dahdi = list;
      this.emit("change", { type: "dahdi", data: list });
    }
  }

  // ---------- channels ----------
  upsertChannel(name, patch) {
    if (!name) return null;
    const prev = this.channels.get(name);
    const base = prev || (() => {
      const { tech, peer } = parseChannel(name);
      return { name, tech, peer, uniqueid: "", linkedid: "", state: 0, stateDesc: "Down", callerNum: "", callerName: "",
        connectedNum: "", connectedName: "", exten: "", context: "", app: "", direction: "", startedAt: Date.now(),
        answeredAt: 0, bridged: [], hold: false, bridgeId: "" };
    })();
    const next = { ...base, ...patch };
    if (next.state === 6 && !next.answeredAt) next.answeredAt = Date.now();
    this.channels.set(name, next);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) this.emit("change", { type: "channel", data: next });
    return next;
  }

  removeChannel(name) {
    const ch = this.channels.get(name);
    if (!ch) return;
    this.channels.delete(name);
    for (const other of this.channels.values()) {
      if (other.bridged.includes(name)) this.upsertChannel(other.name, { bridged: other.bridged.filter((b) => b !== name) });
    }
    this.emit("change", { type: "channelDel", name });
  }

  findByUid(uid) {
    if (!uid) return null;
    for (const c of this.channels.values()) if (c.uniqueid === uid) return c;
    return null;
  }

  link(a, b) {
    const ca = this.channels.get(a), cb = this.channels.get(b);
    if (!ca || !cb) return;
    if (!ca.bridged.includes(b)) this.upsertChannel(a, { bridged: [...ca.bridged, b] });
    if (!cb.bridged.includes(a)) this.upsertChannel(b, { bridged: [...cb.bridged, a] });
  }

  unlink(a, b) {
    const ca = this.channels.get(a), cb = this.channels.get(b);
    if (ca) this.upsertChannel(a, { bridged: ca.bridged.filter((x) => x !== b) });
    if (cb) this.upsertChannel(b, { bridged: cb.bridged.filter((x) => x !== a) });
  }

  async syncChannels() {
    const r = await this.ami.list({ Action: "CoreShowChannels" });
    const now = Date.now();
    const seen = new Set();
    const bridges = new Map();
    for (const e of r.events) {
      if (e.Event !== "CoreShowChannel" || !e.Channel) continue;
      seen.add(e.Channel);
      const prev = this.channels.get(e.Channel);
      const dur = parseDuration(e.Duration);
      const state = Number(e.ChannelState);
      this.upsertChannel(e.Channel, {
        uniqueid: e.UniqueID || e.Uniqueid || prev?.uniqueid || "",
        linkedid: e.Linkedid || prev?.linkedid || "",
        state, stateDesc: e.ChannelStateDesc || prev?.stateDesc || "",
        callerNum: clean(e.CallerIDnum || e.CallerIDNum), callerName: clean(e.CallerIDname || e.CallerIDName),
        connectedNum: clean(e.ConnectedLineNum) || prev?.connectedNum || "", connectedName: clean(e.ConnectedLineName) || prev?.connectedName || "",
        exten: e.Extension || e.Exten || prev?.exten || "", context: e.Context || prev?.context || "",
        app: e.Application || "", appData: e.ApplicationData || "",
        direction: prev?.direction || (e.Application === "AppDial" ? "in" : "out"),
        startedAt: prev?.startedAt && Math.abs(prev.startedAt - (now - dur * 1000)) < 5000 ? prev.startedAt : now - dur * 1000,
        answeredAt: prev?.answeredAt || (state === 6 ? now - dur * 1000 : 0),
        bridgeId: e.BridgeId || prev?.bridgeId || "",
      });
      if (e.BridgedChannel) this.link(e.Channel, e.BridgedChannel);
      if (e.BridgeId) { if (!bridges.has(e.BridgeId)) bridges.set(e.BridgeId, []); bridges.get(e.BridgeId).push(e.Channel); }
    }
    for (const members of bridges.values()) for (const a of members) for (const b of members) if (a !== b) this.link(a, b);
    for (const name of [...this.channels.keys()]) if (!seen.has(name)) this.removeChannel(name);
  }

  // ---------- events ----------
  onEvent(e) {
    const ev = e.Event;
    switch (ev) {
      case "PeerStatus": {
        const m = /^(SIP|PJSIP|IAX2)\/(.+)$/i.exec(e.Peer || "");
        if (!m) break;
        const name = m[2];
        if (!this.peers.has(name)) { this.syncPeers().catch(() => {}); break; }
        const s = e.PeerStatus;
        const addr = String(e.Address || "").replace(/^.*?(\d+\.\d+\.\d+\.\d+).*$/, "$1");
        const patch = {};
        if (s === "Registered" || s === "Reachable") { patch.status = "online"; if (addr) patch.ip = addr; }
        if (s === "Lagged") patch.status = "lagged";
        if (s === "Unregistered") { patch.status = "offline"; patch.ip = ""; patch.latency = null; }
        if (s === "Unreachable") { patch.status = "unreachable"; patch.latency = null; }
        if (e.Time && /^\d+$/.test(e.Time)) patch.latency = Number(e.Time);
        this.upsertPeer(name, patch);
        if (s === "Registered") {
          if (m[1].toUpperCase() === "SIP") this.queueDetail(name);
          else this.syncPjsipContacts().catch(() => {});
        }
        break;
      }
      case "ContactStatus":
        clearTimeout(this.contactDebounce);
        this.contactDebounce = setTimeout(() => this.syncPjsipContacts().catch(() => {}), 1000);
        break;
      case "Registry":
        clearTimeout(this.regDebounce);
        this.regDebounce = setTimeout(() => this.syncRegistry().catch(() => {}), 500);
        break;
      case "Newchannel": {
        const state = Number(e.ChannelState);
        this.upsertChannel(e.Channel, {
          uniqueid: e.Uniqueid || e.UniqueID, linkedid: e.Linkedid || "", state, stateDesc: e.ChannelStateDesc,
          callerNum: clean(e.CallerIDNum), callerName: clean(e.CallerIDName),
          connectedNum: clean(e.ConnectedLineNum), connectedName: clean(e.ConnectedLineName),
          exten: e.Exten || "", context: e.Context || "", direction: state === 4 ? "out" : state === 5 ? "in" : "",
          startedAt: Date.now(),
        });
        break;
      }
      case "Newstate": {
        const state = Number(e.ChannelState);
        const prev = this.channels.get(e.Channel);
        this.upsertChannel(e.Channel, {
          state, stateDesc: e.ChannelStateDesc,
          callerNum: clean(e.CallerIDNum) || prev?.callerNum || "", callerName: clean(e.CallerIDName) || prev?.callerName || "",
          connectedNum: clean(e.ConnectedLineNum) || prev?.connectedNum || "", connectedName: clean(e.ConnectedLineName) || prev?.connectedName || "",
          direction: prev?.direction || (state === 5 ? "in" : state === 4 ? "out" : ""),
        });
        break;
      }
      case "NewCallerid": {
        if (!this.channels.has(e.Channel)) break;
        this.upsertChannel(e.Channel, { callerNum: clean(e.CallerIDNum), callerName: clean(e.CallerIDName) });
        break;
      }
      case "NewConnectedLine": {
        if (!this.channels.has(e.Channel)) break;
        this.upsertChannel(e.Channel, { connectedNum: clean(e.ConnectedLineNum), connectedName: clean(e.ConnectedLineName) });
        break;
      }
      case "NewExten": {
        const ch = this.channels.get(e.Channel);
        if (ch && e.Application) this.upsertChannel(e.Channel, { app: e.Application, appData: e.AppData || "", exten: ch.exten || e.Extension || e.Exten || "" });
        break;
      }
      case "Rename": {
        const oldName = e.Oldname || e.Channel;
        const ch = this.channels.get(oldName);
        if (!ch || !e.Newname) break;
        this.removeChannel(oldName);
        const { tech, peer } = parseChannel(e.Newname);
        this.upsertChannel(e.Newname, { ...ch, name: e.Newname, tech, peer });
        break;
      }
      case "Dial":
      case "DialBegin": {
        if (ev === "Dial" && e.SubEvent && e.SubEvent !== "Begin") break;
        const src = e.Channel, dst = e.Destination || e.DestChannel;
        if (!dst) break;
        const s = this.channels.get(src);
        this.upsertChannel(dst, {
          uniqueid: e.DestUniqueID || e.DestUniqueid || this.channels.get(dst)?.uniqueid || "",
          direction: "in",
          connectedNum: clean(e.CallerIDNum || e.CallerIDnum) || s?.callerNum || "",
          connectedName: clean(e.CallerIDName || e.CallerIDname) || s?.callerName || "",
        });
        if (s) this.upsertChannel(src, { direction: s.direction || "out", dialString: e.Dialstring || e.DialString || "" });
        break;
      }
      case "Bridge": // Asterisk 1.8/11
        if (e.Bridgestate === "Unlink") this.unlink(e.Channel1, e.Channel2);
        else this.link(e.Channel1, e.Channel2);
        break;
      case "Link": this.link(e.Channel1, e.Channel2); break;
      case "Unlink": this.unlink(e.Channel1, e.Channel2); break;
      case "BridgeEnter": {
        if (!this.channels.has(e.Channel)) break;
        this.upsertChannel(e.Channel, { bridgeId: e.BridgeUniqueid });
        for (const c of this.channels.values()) if (c.name !== e.Channel && c.bridgeId === e.BridgeUniqueid) this.link(e.Channel, c.name);
        break;
      }
      case "BridgeLeave": {
        const ch = this.channels.get(e.Channel);
        if (!ch) break;
        for (const b of ch.bridged) this.unlink(e.Channel, b);
        this.upsertChannel(e.Channel, { bridgeId: "" });
        break;
      }
      case "Hold": // 11: Status On/Off; 12+: separate Hold/Unhold
        if (this.channels.has(e.Channel)) this.upsertChannel(e.Channel, { hold: e.Status ? e.Status === "On" : true });
        break;
      case "Unhold":
        if (this.channels.has(e.Channel)) this.upsertChannel(e.Channel, { hold: false });
        break;
      case "Hangup":
        this.removeChannel(e.Channel);
        break;
      case "FullyBooted":
        break;
      case "Reload":
      case "ChannelReload":
        clearTimeout(this.reloadDebounce);
        this.reloadDebounce = setTimeout(() => { this.syncPeers().then(() => this.queueAllDetails()).catch(() => {}); this.syncRegistry().catch(() => {}); }, 1500);
        break;
      default:
        break;
    }
  }
}
