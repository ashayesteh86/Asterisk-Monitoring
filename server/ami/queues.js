// Queue monitoring from AMI QueueStatus (QueueParams / QueueMember / QueueEntry), refreshed on queue events,
// plus per-day counters gathered from queue events (answered, abandoned, longest wait).
import { EventEmitter } from "node:events";

const QUEUE_EVENTS = new Set(["QueueCallerJoin", "Join", "QueueCallerLeave", "Leave", "QueueCallerAbandon", "QueueMemberStatus",
  "QueueMemberAdded", "QueueMemberRemoved", "QueueMemberPaused", "QueueMemberPause", "AgentCalled", "AgentConnect", "AgentComplete",
  "AgentRingNoAnswer", "AgentDump", "QueueMemberPenalty", "QueueMemberRinginuse"]);

export const MEMBER_STATUS = { 0: "unknown", 1: "idle", 2: "inuse", 3: "busy", 4: "invalid", 5: "unavailable", 6: "ringing", 7: "ringinuse", 8: "hold" };

const today = () => new Date().toDateString();
const num = (v) => (v === undefined || v === "" ? 0 : Number(v) || 0);

export class QueueMonitor extends EventEmitter {
  constructor(ami) {
    super();
    this.ami = ami;
    this.queues = [];
    this.daily = { day: today(), byQueue: {} };
    this.timer = null;
    this.supported = true;
    ami.on("connected", () => { this.supported = true; this.refresh(); clearInterval(this.timer); this.timer = setInterval(() => this.refresh(), 5000); });
    ami.on("disconnected", () => { clearInterval(this.timer); this.queues = []; this.emit("change", { type: "queues", data: [] }); });
    ami.on("event", (e) => this.onEvent(e));
  }

  dayStats(queue) {
    if (this.daily.day !== today()) this.daily = { day: today(), byQueue: {} };
    return (this.daily.byQueue[queue] ||= { offered: 0, answered: 0, abandoned: 0, longestWait: 0, totalWait: 0, answeredWait: 0, talk: 0, completed: 0, members: {} });
  }

  memberStats(queue, member) {
    const d = this.dayStats(queue);
    return (d.members[member] ||= { answered: 0, missed: 0, talk: 0 });
  }

  onEvent(e) {
    if (!QUEUE_EVENTS.has(e.Event)) return;
    const q = e.Queue;
    if (q) {
      const d = this.dayStats(q);
      const member = e.MemberName || e.Membername || e.Interface || e.Member || "";
      if (e.Event === "QueueCallerJoin" || e.Event === "Join") d.offered++;
      if (e.Event === "QueueCallerAbandon") {
        d.abandoned++;
        d.longestWait = Math.max(d.longestWait, num(e.HoldTime));
        d.totalWait += num(e.HoldTime);
      }
      if (e.Event === "AgentConnect") {
        d.answered++;
        const hold = num(e.HoldTime ?? e.Holdtime);
        d.answeredWait += hold; d.totalWait += hold;
        d.longestWait = Math.max(d.longestWait, hold);
        this.memberStats(q, member).answered++;
      }
      if (e.Event === "AgentComplete") {
        const talk = num(e.TalkTime);
        d.talk += talk; d.completed++;
        this.memberStats(q, member).talk += talk;
      }
      if (e.Event === "AgentRingNoAnswer") this.memberStats(q, member).missed++;
    }
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 400);
  }

  async refresh() {
    if (this.ami.status !== "connected" || !this.supported) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      const r = await this.ami.list({ Action: "QueueStatus" }, 15000);
      if (r.Response === "Error") { this.supported = false; return; }
      const map = new Map();
      const get = (name) => {
        if (!map.has(name)) map.set(name, { name, strategy: "", max: 0, calls: 0, holdtime: 0, talktime: 0, completed: 0, abandoned: 0,
          serviceLevel: 0, serviceLevelPerf: 0, weight: 0, members: [], entries: [] });
        return map.get(name);
      };
      const now = Date.now();
      for (const e of r.events) {
        if (e.Event === "QueueParams") Object.assign(get(e.Queue), {
          strategy: e.Strategy || "", max: num(e.Max), calls: num(e.Calls), holdtime: num(e.Holdtime), talktime: num(e.TalkTime),
          completed: num(e.Completed), abandoned: num(e.Abandoned), serviceLevel: num(e.ServiceLevel), serviceLevelPerf: Number(e.ServicelevelPerf) || 0,
          weight: num(e.Weight),
        });
        else if (e.Event === "QueueMember") {
          const iface = e.StateInterface || e.Location || e.Interface || "";
          const ext = /^(?:SIP|PJSIP|IAX2|Local)\/([^@/-]+)/i.exec(e.Location || iface)?.[1] || "";
          get(e.Queue).members.push({
            name: e.Name || e.MemberName || iface, location: e.Location || iface, interface: iface, ext,
            membership: e.Membership || "", penalty: num(e.Penalty), callsTaken: num(e.CallsTaken),
            lastCall: num(e.LastCall), lastPause: num(e.LastPause), loginTime: num(e.LoginTime),
            status: MEMBER_STATUS[num(e.Status)] || "unknown", paused: e.Paused === "1", pausedReason: e.PausedReason || "",
            inCall: e.InCall === "1" || num(e.Status) === 2,
          });
        } else if (e.Event === "QueueEntry") get(e.Queue).entries.push({
          position: num(e.Position), channel: e.Channel, uniqueid: e.Uniqueid || e.UniqueID || "",
          callerNum: e.CallerIDNum || e.CallerID || "", callerName: e.CallerIDName && e.CallerIDName !== "<unknown>" ? e.CallerIDName : "",
          wait: num(e.Wait), joinedAt: now - num(e.Wait) * 1000,
        });
      }
      const queues = [...map.values()].filter((q) => q.name !== "default").sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
      for (const q of queues) {
        q.entries.sort((a, b) => a.position - b.position);
        q.today = structuredClone(this.dayStats(q.name));
      }
      if (JSON.stringify(stripTimes(queues)) !== JSON.stringify(stripTimes(this.queues))) {
        this.queues = queues;
        this.emit("change", { type: "queues", data: queues });
      }
    } catch { /* timeout / not loaded */ } finally {
      this.running = false;
      if (this.again) { this.again = false; setTimeout(() => this.refresh(), 200); }
    }
  }
}

// joinedAt drifts by a few ms per refresh; ignore it when deciding whether anything changed
const stripTimes = (qs) => qs.map((q) => ({ ...q, entries: q.entries.map(({ joinedAt, wait, ...r }) => r) }));
