// Development-only fake Asterisk AMI server with simulated call traffic.
// MOCK_VERSION=11 (default) emits Asterisk 11 events (Dial/Bridge); MOCK_VERSION=16 emits 12+ events (DialBegin/BridgeEnter).
// Login: admin / mock.  Optional MOCK_CDR=mysql://user:pass@host/db writes a CDR row per finished call.
import net from "node:net";
import mysql from "mysql2/promise";

const VERSION = process.env.MOCK_VERSION || "11";
const LEGACY = Number(VERSION) < 12;
const PORT = Number(process.env.MOCK_PORT) || 5038;
const AMI_VERSION = LEGACY ? "1.3" : "2.10.4";
const FULL_VERSION = LEGACY ? "11.25.3" : "16.30.0";
const cdrPool = process.env.MOCK_CDR ? mysql.createPool(process.env.MOCK_CDR) : null;

const NAMES = ["علی رضایی", "مریم احمدی", "حسین کریمی", "زهرا موسوی", "رضا حسینی", "فاطمه نوری", "محمد جعفری", "سارا کاظمی",
  "امیر صادقی", "نرگس رحیمی", "مهدی قاسمی", "لیلا اکبری", "پذیرش", "انبار", "حسابداری", "مدیرعامل", "فروش ۱", "فروش ۲",
  "پشتیبانی ۱", "پشتیبانی ۲", "اتاق جلسه", "نگهبانی", "آشپزخانه", "IT"];
const AGENTS = ["Yealink SIP-T21P_E2 52.84.0.15", "Yealink SIP-T46S 66.85.0.5", "Grandstream GXP1625 1.0.4.128", "Grandstream GXP2170 1.0.11.3",
  "Cisco/SPA504G-7.5.5", "snom320/8.7.5.35", "Panasonic_KX-HDV130/03.100", "Fanvil X3S 2.10.2.7022", "MicroSIP/3.21.3", "Zoiper rv2.10.11.4",
  "Linphone/5.0.16 (belle-sip/5.0.1)", "Yealink SIP-T31G 124.85.0.40", "Htek UC912G 2.0.4.6", "Grandstream DP750 1.0.3.37"];

const peers = new Map();
NAMES.forEach((n, i) => {
  const ext = String(101 + i);
  const online = i % 9 !== 7;
  peers.set(ext, { name: ext, callerName: n, ua: AGENTS[i % AGENTS.length], ip: online ? `192.168.10.${20 + i}` : "", online, latency: 3 + (i % 7) * 4, trunk: false });
});
peers.set("mokhaberat", { name: "mokhaberat", callerName: "", ua: "", ip: "10.20.30.1", online: true, latency: 12, trunk: true });
peers.set("itsp-voip", { name: "itsp-voip", callerName: "", ua: "", ip: "", online: false, latency: null, trunk: true });

const configs = {
  "sip_custom.conf": [{ name: "panel-test", vars: [["type", "peer"], ["host", "10.20.30.50"], ["context", "from-trunk"], ["insecure", "port,invite"], ["qualify", "yes"], ["disallow", "all"], ["allow", "alaw,ulaw"]] }],
  "sip.conf": [{ name: "general", vars: [["context", "default"], ["allowguest", "no"], ["register", "1001:pass@itsp.example.com/1001"]] }],
};

const clients = new Set();
const channels = new Map(); // name → channel
let uidSeq = Math.floor(Date.now() / 1000);
let chanSeq = 0x1a0;

function send(sock, obj) {
  let s = "";
  for (const [k, v] of Object.entries(obj)) for (const item of [].concat(v)) s += `${k}: ${item}\r\n`;
  sock.write(s + "\r\n");
}
function broadcast(obj) { for (const c of clients) if (c.auth) send(c.sock, { Event: obj.Event, Privilege: "call,all", ...obj }); }

const uid = () => `${++uidSeq}.${Math.floor(Math.random() * 100)}`;
const chanName = (peer) => `SIP/${peer}-${(++chanSeq).toString(16).padStart(8, "0")}`;
const STATE = { 0: "Down", 4: "Ring", 5: "Ringing", 6: "Up" };

function newChannel(peer, { cid, cname, exten = "", state = 0, linkedid, app = "" }) {
  const ch = { name: peer === "DAHDI" ? `DAHDI/i1/${cid}-${(++chanSeq).toString(16)}` : chanName(peer), peer, uid: uid(), state, cid, cname, exten,
    linkedid: "", connected: "", connectedName: "", start: Date.now(), answer: 0, bridged: null, bridgeId: "", app };
  ch.linkedid = linkedid || ch.uid;
  channels.set(ch.name, ch);
  broadcast({ Event: "Newchannel", Channel: ch.name, ChannelState: state, ChannelStateDesc: STATE[state], CallerIDNum: cid, CallerIDName: cname || "<unknown>",
    Uniqueid: ch.uid, ...(LEGACY ? {} : { Linkedid: ch.linkedid, ConnectedLineNum: "<unknown>", ConnectedLineName: "<unknown>" }), Exten: exten, Context: "from-internal" });
  return ch;
}
function setState(ch, state) {
  if (!channels.has(ch.name)) return;
  ch.state = state;
  if (state === 6 && !ch.answer) ch.answer = Date.now();
  broadcast({ Event: "Newstate", Channel: ch.name, ChannelState: state, ChannelStateDesc: STATE[state], CallerIDNum: ch.cid, CallerIDName: ch.cname || "",
    Uniqueid: ch.uid, ...(LEGACY ? {} : { ConnectedLineNum: ch.connected || "<unknown>", ConnectedLineName: ch.connectedName || "<unknown>", Linkedid: ch.linkedid }) });
}
function dial(src, dst, dialstring) {
  dst.connected = src.cid; dst.connectedName = src.cname;
  src.connected = dst.cid; src.app = "Dial"; dst.app = "AppDial";
  if (LEGACY) broadcast({ Event: "Dial", SubEvent: "Begin", Channel: src.name, Destination: dst.name, CallerIDNum: src.cid, CallerIDName: src.cname || "<unknown>",
    UniqueID: src.uid, DestUniqueID: dst.uid, Dialstring: dialstring });
  else broadcast({ Event: "DialBegin", Channel: src.name, DestChannel: dst.name, CallerIDNum: src.cid, CallerIDName: src.cname || "<unknown>",
    Uniqueid: src.uid, DestUniqueid: dst.uid, DialString: dialstring, Linkedid: src.linkedid });
}
function bridge(a, b) {
  a.bridged = b.name; b.bridged = a.name;
  if (LEGACY) broadcast({ Event: "Bridge", Bridgestate: "Link", Bridgetype: "core", Channel1: a.name, Channel2: b.name, Uniqueid1: a.uid, Uniqueid2: b.uid, CallerID1: a.cid, CallerID2: b.cid });
  else {
    const id = `bridge-${a.uid}`;
    a.bridgeId = b.bridgeId = id;
    broadcast({ Event: "BridgeEnter", BridgeUniqueid: id, Channel: a.name, Uniqueid: a.uid });
    broadcast({ Event: "BridgeEnter", BridgeUniqueid: id, Channel: b.name, Uniqueid: b.uid });
  }
}
function hangup(ch, cause = 16) {
  if (!channels.has(ch.name)) return;
  channels.delete(ch.name);
  if (!LEGACY && ch.bridgeId) broadcast({ Event: "BridgeLeave", BridgeUniqueid: ch.bridgeId, Channel: ch.name, Uniqueid: ch.uid });
  broadcast({ Event: "Hangup", Channel: ch.name, Uniqueid: ch.uid, CallerIDNum: ch.cid, Cause: cause, "Cause-txt": "Normal Clearing" });
}

async function writeCdr(src, dst, srcCh, dstCh, start, answer, end, disposition) {
  if (!cdrPool) return;
  const fmt = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  await cdrPool.query(`INSERT INTO cdr (calldate, clid, src, dst, dcontext, channel, dstchannel, lastapp, lastdata, duration, billsec, disposition, amaflags, uniqueid, recordingfile)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,3,?,?)`, [fmt(start), `"${src}" <${src}>`, src, dst, "from-internal", srcCh, dstCh, "Dial", dstCh.split("-")[0],
    Math.round((end - start) / 1000), answer ? Math.round((end - answer) / 1000) : 0, disposition, `${Math.floor(start / 1000)}.${Math.floor(Math.random() * 99)}`, ""]).catch((e) => console.error("cdr", e.message));
}

/** A two-leg call: a (caller) → b (callee). Rings, maybe answers, talks, hangs up. */
function call({ fromPeer, fromCid, fromName, toPeer, dialed, talk = 15000 + Math.random() * 60000, answerProb = 0.75 }) {
  const a = newChannel(fromPeer, { cid: fromCid, cname: fromName, exten: dialed, state: fromPeer === "DAHDI" || peers.get(fromPeer)?.trunk ? 0 : 4 });
  if (fromPeer === "DAHDI" || peers.get(fromPeer)?.trunk) setTimeout(() => setState(a, 6), 300);
  setTimeout(() => {
    if (!channels.has(a.name)) return;
    const target = peers.get(toPeer);
    const b = newChannel(toPeer, { cid: target?.trunk ? dialed : toPeer, cname: target?.callerName || "", linkedid: a.linkedid });
    dial(a, b, `SIP/${toPeer}${target?.trunk ? "/" + dialed : ""}`);
    setTimeout(() => setState(b, 5), 200);
    const start = Date.now();
    const answers = Math.random() < answerProb && (!target || target.online || target.trunk);
    setTimeout(() => {
      if (!channels.has(a.name) || !channels.has(b.name)) return;
      if (!answers) {
        hangup(b, 19); hangup(a, 19);
        writeCdr(fromCid, dialed, a.name, b.name, start, 0, Date.now(), Math.random() < 0.8 ? "NO ANSWER" : "BUSY");
        return;
      }
      setState(b, 6); setState(a, 6); bridge(a, b);
      const answer = Date.now();
      setTimeout(() => {
        const ended = Date.now();
        if (channels.has(b.name)) hangup(b);
        if (channels.has(a.name)) hangup(a);
        writeCdr(fromCid, dialed, a.name, b.name, start, answer, ended, "ANSWERED");
      }, talk);
    }, 3000 + Math.random() * 9000);
  }, 800);
  return a;
}

const extList = () => [...peers.values()].filter((p) => !p.trunk && p.online);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const mobile = () => `09${pick(["12", "13", "19", "35", "36", "01", "02", "21"])}${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const busyPeers = () => new Set([...channels.values()].map((c) => c.peer));

// ---------- queues ----------
const queues = {
  400: { strategy: "ringall", members: ["101", "102", "103", "104", "105", "106"].map((e) => ({ ext: e, paused: false, calls: 0, last: 0 })), entries: [], completed: 0, abandoned: 0, holdSum: 0, talkSum: 0 },
  401: { strategy: "leastrecent", members: ["107", "108", "109", "110", "111", "112"].map((e) => ({ ext: e, paused: false, calls: 0, last: 0 })), entries: [], completed: 0, abandoned: 0, holdSum: 0, talkSum: 0 },
};
const memberStatus = (ext) => {
  const p = peers.get(ext);
  if (!p?.online) return 5;
  const chs = [...channels.values()].filter((c) => c.peer === ext);
  if (chs.some((c) => c.state === 5)) return 6;
  return chs.length ? 2 : 1;
};
const ev = (name, extra) => broadcast({ Event: name, ...extra });
function queueCall() {
  const qn = pick(Object.keys(queues));
  const q = queues[qn];
  if (q.entries.length > 5) return;
  const cid = mobile();
  const a = newChannel(Math.random() < 0.5 ? "mokhaberat" : "DAHDI", { cid, cname: "", exten: qn });
  setTimeout(() => setState(a, 6), 200);
  a.app = "Queue";
  const entry = { ch: a, joined: Date.now() };
  q.entries.push(entry);
  ev(LEGACY ? "Join" : "QueueCallerJoin", { Channel: a.name, CallerIDNum: cid, CallerIDName: "unknown", Queue: qn, Position: q.entries.length, Count: q.entries.length, Uniqueid: a.uid });
  const wait = 4000 + Math.random() * 40000;
  setTimeout(() => {
    const idx = q.entries.indexOf(entry);
    if (idx < 0 || !channels.has(a.name)) return;
    const free = q.members.filter((m) => !m.paused && memberStatus(m.ext) === 1);
    const leave = () => { q.entries.splice(q.entries.indexOf(entry), 1); ev(LEGACY ? "Leave" : "QueueCallerLeave", { Channel: a.name, Queue: qn, Count: q.entries.length, Position: idx + 1, Uniqueid: a.uid }); };
    const hold = Math.round((Date.now() - entry.joined) / 1000);
    if (!free.length || Math.random() < 0.15) {
      ev("QueueCallerAbandon", { Channel: a.name, Queue: qn, Position: idx + 1, OriginalPosition: idx + 1, HoldTime: hold, Uniqueid: a.uid });
      q.abandoned++; leave(); hangup(a);
      writeCdr(cid, qn, a.name, "", entry.joined, 0, Date.now(), "NO ANSWER");
      return;
    }
    const m = pick(free);
    const b = newChannel(m.ext, { cid: m.ext, cname: peers.get(m.ext).callerName, linkedid: a.linkedid });
    dial(a, b, `SIP/${m.ext}`);
    ev("AgentCalled", { Queue: qn, AgentCalled: `SIP/${m.ext}`, AgentName: peers.get(m.ext).callerName, ChannelCalling: a.name, DestinationChannel: b.name, CallerIDNum: cid, Uniqueid: a.uid, Interface: `SIP/${m.ext}`, MemberName: peers.get(m.ext).callerName });
    setTimeout(() => setState(b, 5), 200);
    setTimeout(() => {
      if (!channels.has(a.name) || !channels.has(b.name)) return;
      setState(b, 6); bridge(a, b); leave();
      q.completed++; q.holdSum += hold; m.calls++; m.last = Math.floor(Date.now() / 1000);
      ev("AgentConnect", { Queue: qn, Uniqueid: a.uid, Channel: b.name, Member: `SIP/${m.ext}`, MemberName: peers.get(m.ext).callerName, Interface: `SIP/${m.ext}`, HoldTime: hold, Holdtime: hold, RingTime: 3, BridgedChannel: a.name });
      const talk = 15000 + Math.random() * 90000;
      const ans = Date.now();
      setTimeout(() => {
        hangup(b); hangup(a);
        q.talkSum += Math.round(talk / 1000);
        ev("AgentComplete", { Queue: qn, Uniqueid: a.uid, Channel: b.name, Member: `SIP/${m.ext}`, MemberName: peers.get(m.ext).callerName, Interface: `SIP/${m.ext}`, HoldTime: hold, TalkTime: Math.round(talk / 1000), Reason: "caller" });
        writeCdr(cid, qn, a.name, b.name, entry.joined, ans, Date.now(), "ANSWERED");
      }, talk);
    }, 2500);
  }, wait);
}

const m_paused_msg = (a) => (a.Paused === "true" || a.Paused === "1" ? "Interface paused successfully" : "Interface unpaused successfully");

function randomTraffic() {
  const busy = busyPeers();
  const free = extList().filter((p) => !busy.has(p.name));
  if (channels.size > 24 || free.length < 2) return;
  const r = Math.random();
  if (r < 0.45) { // inbound from PSTN
    const to = pick(free);
    const cid = Math.random() < 0.3 ? `021${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` : mobile();
    call({ fromPeer: Math.random() < 0.5 ? "mokhaberat" : "DAHDI", fromCid: cid, fromName: "", toPeer: to.name, dialed: to.name });
  } else if (r < 0.8) { // outbound
    const from = pick(free);
    const num = mobile();
    call({ fromPeer: from.name, fromCid: from.name, fromName: from.callerName, toPeer: "mokhaberat", dialed: num });
  } else { // internal
    const from = pick(free);
    const to = pick(free.filter((p) => p !== from));
    call({ fromPeer: from.name, fromCid: from.name, fromName: from.callerName, toPeer: to.name, dialed: to.name });
  }
}

function randomPresence() {
  const p = pick([...peers.values()].filter((x) => !x.trunk && x.name !== "101" && x.name !== "102"));
  if (busyPeers().has(p.name)) return;
  p.online = !p.online;
  p.ip = p.online ? `192.168.10.${20 + Number(p.name) - 101}` : "";
  broadcast({ Event: "PeerStatus", ChannelType: "SIP", Peer: `SIP/${p.name}`, PeerStatus: p.online ? "Registered" : "Unregistered", ...(p.online ? { Address: `${p.ip}:5060` } : {}) });
}

// ---------- actions ----------
function handle(client, a) {
  const id = a.ActionID ? { ActionID: a.ActionID } : {};
  const ok = (extra = {}) => send(client.sock, { Response: "Success", ...id, ...extra });
  const err = (m) => send(client.sock, { Response: "Error", ...id, Message: m });
  const list = (events, completeEvent, msg = "will follow") => {
    ok({ EventList: "start", Message: msg });
    for (const e of events) send(client.sock, { ...e, ...id });
    send(client.sock, { Event: completeEvent, EventList: "Complete", ListItems: events.length, ...id });
  };
  if (a.Action !== "Login" && !client.auth) return err("Permission denied");
  switch (a.Action) {
    case "Login":
      if (a.Username === "admin" && a.Secret === "mock") { client.auth = true; ok({ Message: "Authentication accepted" }); if (!LEGACY) send(client.sock, { Event: "FullyBooted", Status: "Fully Booted" }); }
      else { err("Authentication failed"); setTimeout(() => client.sock.end(), 50); }
      break;
    case "Ping": ok({ Ping: "Pong", Timestamp: (Date.now() / 1000).toFixed(6) }); break;
    case "CoreSettings": ok({ AMIversion: AMI_VERSION, AsteriskVersion: FULL_VERSION, SystemName: "issabel-mock", CoreMaxCalls: 0 }); break;
    case "SIPpeers":
      list([...peers.values()].map((p) => ({ Event: "PeerEntry", Channeltype: "SIP", ObjectName: p.name, ChanObjectType: "peer", IPaddress: p.ip || "-none-",
        IPport: p.ip ? "5060" : "0", Dynamic: p.trunk ? "no" : "yes", Status: p.online ? `OK (${p.latency} ms)` : p.trunk ? "UNREACHABLE" : "UNKNOWN", Description: "" })), "PeerlistComplete", "Peer status list will follow");
      break;
    case "SIPshowpeer": {
      const p = peers.get(a.Peer);
      if (!p) return err("Peer not found");
      ok({ Channeltype: "SIP", ObjectName: p.name, Callerid: p.trunk ? '"" <>' : `"${p.callerName}" <${p.name}>`, Context: p.trunk ? "from-trunk" : "from-internal",
        "SIP-Useragent": p.online ? p.ua : "", "Address-IP": p.ip || "(null)", Status: p.online ? `OK (${p.latency} ms)` : "UNKNOWN",
        "Reg-Contact": p.online && !p.trunk ? `sip:${p.name}@${p.ip}:5060` : "", ToHost: p.trunk ? p.ip || "itsp.example.com" : "", Codecs: "(ulaw|alaw|g729)", Nat: "Never" });
      break;
    }
    case "SIPshowregistry":
      list([{ Event: "RegistryEntry", Host: "itsp.example.com", Port: 5060, Username: "1001", Domain: "itsp.example.com", Refresh: 105, State: "Request Sent", RegistrationTime: 0 }], "RegistrationsComplete");
      break;
    case "SIPqualifypeer": ok({ Message: "SIP peer found - will qualify" }); break;
    case "PJSIPShowEndpoints": case "PJSIPShowContacts": case "PJSIPShowRegistrationsOutbound":
      if (LEGACY) err("Invalid/unknown command"); else list([], a.Action.replace("PJSIPShow", "") + "Complete");
      break;
    case "DAHDIShowChannels":
      list(Array.from({ length: 30 }, (_, i) => ({ Event: "DAHDIShowChannels", DAHDIChannel: i + 1 + (i >= 15 ? 1 : 0), Signalling: "ISDN PRI", Context: "from-pstn", DND: "Disabled", Alarm: "No Alarm",
        Channel: [...channels.values()].filter((c) => c.peer === "DAHDI")[i]?.name || "" })), "DAHDIShowChannelsComplete");
      break;
    case "CoreShowChannels":
      list([...channels.values()].map((c) => ({ Event: "CoreShowChannel", Channel: c.name, UniqueID: c.uid, Context: "from-internal", Extension: c.exten, Priority: 1,
        ChannelState: c.state, ChannelStateDesc: STATE[c.state], Application: c.app || "Dial", ApplicationData: "", CallerIDnum: c.cid, CallerIDname: c.cname,
        ConnectedLineNum: c.connected, ConnectedLineName: c.connectedName, Duration: new Date(Date.now() - c.start).toISOString().slice(11, 19), AccountCode: "",
        ...(LEGACY ? { BridgedChannel: c.bridged || "", BridgedUniqueID: channels.get(c.bridged)?.uid || "" } : { BridgeId: c.bridgeId, Linkedid: c.linkedid }) })), "CoreShowChannelsComplete", "Channels will follow");
      break;
    case "Originate": {
      const m = /^(?:SIP|PJSIP)\/(\w+)$|^Local\/(\w+)@/.exec(a.Channel || "");
      const ext = m && (m[1] || m[2]);
      if (!ext || !peers.get(ext)?.online) { ok({ Message: "Originate successfully queued" }); return; }
      ok({ Message: "Originate successfully queued" });
      const caller = peers.get(ext);
      const leg = newChannel(ext, { cid: ext, cname: caller.callerName, state: 0 });
      setTimeout(() => setState(leg, 5), 300);
      setTimeout(() => {
        if (!channels.has(leg.name)) return;
        setState(leg, 6);
        if (a.Application === "ChanSpy") {
          leg.app = "ChanSpy";
          const target = String(a.Data).split(",")[0];
          const end = setInterval(() => { if (!channels.has(target)) { clearInterval(end); hangup(leg); } }, 1000);
          return;
        }
        const target = peers.get(a.Exten);
        const b = newChannel(target ? a.Exten : "mokhaberat", { cid: a.Exten, cname: target?.callerName || "", linkedid: leg.linkedid });
        dial(leg, b, a.Exten);
        setTimeout(() => setState(b, 5), 200);
        setTimeout(() => {
          if (!channels.has(leg.name) || !channels.has(b.name)) return;
          setState(b, 6); bridge(leg, b);
          setTimeout(() => { hangup(b); hangup(leg); }, 40000);
        }, 4000);
      }, 2500);
      break;
    }
    case "Hangup": {
      const ch = channels.get(a.Channel);
      if (!ch) return err("No such channel");
      ok({ Message: "Channel Hungup" });
      hangup(ch);
      const other = channels.get(ch.bridged);
      if (other) setTimeout(() => hangup(other), 100);
      break;
    }
    case "Redirect": {
      const ch = channels.get(a.Channel);
      if (!ch) return err("Channel specified does not exist");
      ok({ Message: "Redirect successful" });
      const old = channels.get(ch.bridged);
      if (old) hangup(old);
      ch.bridged = null;
      const target = peers.get(a.Exten);
      if (!target) return;
      const b = newChannel(a.Exten, { cid: a.Exten, cname: target.callerName, linkedid: ch.linkedid });
      dial(ch, b, a.Exten);
      setTimeout(() => setState(b, 5), 200);
      setTimeout(() => { if (channels.has(b.name) && channels.has(ch.name)) { setState(b, 6); bridge(ch, b); } }, 3000);
      break;
    }
    case "Command": {
      const outputs = {
        "sip reload": [" Reloading SIP"], "dialplan reload": ["Dialplan reloaded."], reload: [],
        "core show uptime": ["System uptime: 12 days, 3 hours, 41 minutes, 7 seconds", "Last reload: 2 hours, 5 minutes, 1 second"],
        "core show calls": [`${Math.ceil(channels.size / 2)} active calls`, "18342 calls processed"],
        "core show uptime seconds": ["System uptime: 1049122", "Last reload: 7312"],
        "core show channels count": [`${channels.size} active channels`, `${Math.ceil(channels.size / 2)} active calls`, "18342 calls processed"],
        "core show sysinfo": ["", "System Statistics", "-----------------", "  System Uptime:             291 hours", "  Total RAM:                 3881012 KiB", "  Free RAM:                  1221344 KiB",
          "  Buffer RAM:                203112 KiB", "  Total Swap Space:          2097148 KiB", "  Free Swap Space:           2097148 KiB", "", "  Number of Processes:       187", ""],
        "module show like chan_": ["Module                         Description                              Use Count  Status      Support Level",
          "chan_sip.so                    Session Initiation Protocol (SIP)        14         Running              extended", "chan_dahdi.so                  DAHDI Telephony                          30         Running              core",
          "chan_iax2.so                   Inter Asterisk eXchange (Ver 2)          0          Running              core", "chan_local.so                  Local Proxy Channel (Note: used internal 0          Running              core", "4 modules loaded"],
      };
      const out = outputs[a.Command] ?? [`No such command '${a.Command}'`];
      if (LEGACY) client.sock.write(`Response: Follows\r\nPrivilege: Command\r\n${a.ActionID ? `ActionID: ${a.ActionID}\r\n` : ""}${out.join("\n")}${out.length ? "\n" : ""}--END COMMAND--\r\n\r\n`);
      else ok({ Message: "Command output follows", Output: out });
      if (/reload/.test(a.Command)) setTimeout(() => broadcast({ Event: "Reload", Module: "chan_sip.so", Status: "0" }), 300);
      break;
    }
    case "GetConfig": {
      const cfg = configs[a.Filename];
      if (!cfg) return err("Config file not found");
      const out = {};
      cfg.forEach((c, i) => {
        const n = String(i).padStart(6, "0");
        out[`Category-${n}`] = c.name;
        c.vars.forEach(([k, v], j) => { out[`Line-${n}-${String(j).padStart(6, "0")}`] = `${k}=${v}`; });
      });
      ok(out);
      break;
    }
    case "UpdateConfig": {
      const cfg = configs[a.SrcFilename];
      if (!cfg) return err("Config file not found");
      const work = structuredClone(cfg);
      for (let i = 0; ; i++) {
        const n = String(i).padStart(6, "0");
        const op = a[`Action-${n}`];
        if (!op) break;
        const cat = a[`Cat-${n}`];
        const c = work.find((x) => x.name === cat);
        if (op === "NewCat") work.push({ name: cat, vars: [] });
        else if (op === "DelCat") { if (!c) return err("Delete category did not complete successfully"); work.splice(work.indexOf(c), 1); }
        else if (op === "Append") { if (!c) return err("Update did not complete successfully"); c.vars.push([a[`Var-${n}`], a[`Value-${n}`]]); }
        else if (op === "Delete") {
          if (!c) return err("Delete did not complete successfully");
          const idx = c.vars.findIndex(([k, v]) => k === a[`Var-${n}`] && (!a[`Match-${n}`] || v === a[`Match-${n}`]));
          if (idx < 0) return err("Delete did not complete successfully");
          c.vars.splice(idx, 1);
        } else return err("Unknown action");
      }
      configs[a.DstFilename || a.SrcFilename] = work;
      ok();
      break;
    }
    case "QueueStatus": {
      const events = [];
      for (const [qn, q] of Object.entries(queues)) {
        if (a.Queue && a.Queue !== qn) continue;
        events.push({ Event: "QueueParams", Queue: qn, Max: 0, Strategy: q.strategy, Calls: q.entries.length, Holdtime: q.completed ? Math.round(q.holdSum / q.completed) : 0,
          TalkTime: q.completed ? Math.round(q.talkSum / Math.max(1, q.completed)) : 0, Completed: q.completed, Abandoned: q.abandoned, ServiceLevel: 60, ServicelevelPerf: q.completed ? (90 - q.abandoned % 10).toFixed(1) : "0.0", Weight: 0 });
        for (const m of q.members) events.push({ Event: "QueueMember", Queue: qn, Name: peers.get(m.ext)?.callerName || m.ext, Location: `SIP/${m.ext}`, StateInterface: `SIP/${m.ext}`,
          Membership: "static", Penalty: 0, CallsTaken: m.calls, LastCall: m.last, Status: memberStatus(m.ext), Paused: m.paused ? 1 : 0, ...(LEGACY ? {} : { PausedReason: m.reason || "", InCall: memberStatus(m.ext) === 2 ? 1 : 0, LoginTime: 0 }) });
        q.entries.forEach((e, i) => events.push({ Event: "QueueEntry", Queue: qn, Position: i + 1, Channel: e.ch.name, Uniqueid: e.ch.uid, CallerIDNum: e.ch.cid, CallerIDName: "unknown",
          ConnectedLineNum: "unknown", Wait: Math.round((Date.now() - e.joined) / 1000) }));
      }
      list(events, "QueueStatusComplete", "Queue status will follow");
      break;
    }
    case "QueuePause": {
      const ext = /\/(\w+)$/.exec(a.Interface || "")?.[1];
      let hit = false;
      for (const [qn, q] of Object.entries(queues)) {
        if (a.Queue && a.Queue !== qn) continue;
        const m = q.members.find((x) => x.ext === ext);
        if (!m) continue;
        hit = true; m.paused = a.Paused === "true" || a.Paused === "1"; m.reason = a.Reason || "";
        ev(LEGACY ? "QueueMemberPaused" : "QueueMemberPause", { Queue: qn, Location: a.Interface, Interface: a.Interface, MemberName: peers.get(ext)?.callerName, Paused: m.paused ? 1 : 0, Reason: m.reason });
      }
      if (!hit) return err("Interface not found");
      ok({ Message: m_paused_msg(a) });
      break;
    }
    case "QueueAdd": {
      const q = queues[a.Queue];
      const ext = /\/(\w+)$/.exec(a.Interface || "")?.[1];
      if (!q || !ext) return err("Unable to add interface: No such queue");
      if (q.members.some((m) => m.ext === ext)) return err("Unable to add interface: Already there");
      q.members.push({ ext, paused: a.Paused === "true", calls: 0, last: 0 });
      ev("QueueMemberAdded", { Queue: a.Queue, Location: a.Interface, MemberName: a.MemberName || ext });
      ok({ Message: "Added interface to queue" });
      break;
    }
    case "QueueRemove": {
      const q = queues[a.Queue];
      const ext = /\/(\w+)$/.exec(a.Interface || "")?.[1];
      const i = q ? q.members.findIndex((m) => m.ext === ext) : -1;
      if (i < 0) return err("Unable to remove interface: Not there");
      q.members.splice(i, 1);
      ev("QueueMemberRemoved", { Queue: a.Queue, Location: a.Interface });
      ok({ Message: "Removed interface from queue" });
      break;
    }
    case "CoreStatus": {
      const d = new Date(Date.now() - 12 * 86400e3);
      ok({ CoreStartupDate: d.toISOString().slice(0, 10), CoreStartupTime: d.toTimeString().slice(0, 8), CoreReloadDate: new Date().toISOString().slice(0, 10), CoreReloadTime: "08:15:02", CoreCurrentCalls: Math.ceil(channels.size / 2) });
      break;
    }
    case "Getvar": {
      const m = /^SHELL\((.*)\)$/s.exec(a.Variable || "");
      if (!m) return ok({ Variable: a.Variable, Value: "" });
      if (!LEGACY && !process.env.MOCK_LIVE_DANGEROUSLY) return err("Function SHELL cannot be read from an external source; live_dangerously is disabled");
      // synthetic host metrics: demo values instead of the machine the mock runs on
      ok({ Variable: a.Variable, Value: fakeMetrics() });
      break;
    }
    case "Logoff": ok({ Message: "Thanks for all the fish." }); client.sock.end(); break;
    default: err("Invalid/unknown command");
  }
}

let cpuT = 0;
function fakeMetrics() {
  const busy = 0.08 + 0.12 * Math.abs(Math.sin(Date.now() / 60000)) + channels.size * 0.004;
  const idle1 = 9_000_000 + cpuT * 800, total1 = idle1 / (1 - busy) ;
  cpuT++;
  const line = (idle, total) => `cpu  ${Math.round(total - idle)} 0 0 ${Math.round(idle)} 0 0 0 0 0 0`;
  const kb = (gb) => Math.round(gb * 1024 * 1024);
  return [
    "up=1049122.5", `load=${(busy * 4).toFixed(2)} ${(busy * 3.5).toFixed(2)} ${(busy * 3).toFixed(2)}`, "ncpu=8", "host=pbx-demo 5.10.0",
    line(idle1, total1), line(idle1 + 790, total1 + 800 + 800 * busy / (1 - busy)),
    `MemTotal:${kb(16)}`, "MemFree:4194304", `MemAvailable:${kb(10.2 - channels.size * 0.01)}`, "Buffers:262144", "Cached:4194304", `SwapTotal:${kb(4)}`, `SwapFree:${kb(3.9)}`,
    `disk=/:${kb(200)}:${kb(71.5)}`, `disk=/var/spool/asterisk:${kb(500)}:${kb(212)}`, `disk=/boot:${kb(1)}:${kb(0.2)}`,
    "svc=asterisk:up", "svc=mysqld:up", "svc=httpd:up", "svc=fail2ban-server:up", "svc=sshd:up", "svc=crond:up",
    `astp=${(busy * 30).toFixed(1)}:${Math.round(380 * 1024 + channels.size * 900)}`,
  ].join(";");
}

net.createServer((sock) => {
  const client = { sock, auth: false, buf: "" };
  clients.add(client);
  sock.setEncoding("utf8");
  sock.write(`Asterisk Call Manager/${AMI_VERSION}\r\n`);
  sock.on("data", (d) => {
    client.buf += d;
    let i;
    while ((i = client.buf.indexOf("\r\n\r\n")) >= 0) {
      const block = client.buf.slice(0, i);
      client.buf = client.buf.slice(i + 4);
      const a = {};
      for (const line of block.split("\r\n")) { const k = line.indexOf(":"); if (k > 0) a[line.slice(0, k).trim()] = line.slice(k + 1).trim(); }
      if (a.Action) handle(client, a);
    }
  });
  sock.on("close", () => clients.delete(client));
  sock.on("error", () => {});
}).listen(PORT, "127.0.0.1", () => console.log(`[mock-ami] Asterisk ${FULL_VERSION} mock on 127.0.0.1:${PORT} (admin/mock)`));

for (let i = 0; i < 6; i++) setTimeout(randomTraffic, i * 400);
setInterval(randomTraffic, 4000);
setInterval(randomPresence, 25000);
setInterval(queueCall, 7000);
for (let i = 0; i < 3; i++) setTimeout(queueCall, 1000 + i * 900);
