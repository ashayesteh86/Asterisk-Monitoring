// Derive what the operator panel shows from raw peers + channels.
const digits = (s) => /^[+\d*#]+$/.test(String(s || "")) ? String(s) : "";

export const STATUS = {
  ringing: { label: "در حال زنگ", color: "ring" },
  talking: { label: "در حال مکالمه", color: "talk" },
  hold: { label: "انتظار (Hold)", color: "hold" },
  dialing: { label: "در حال شماره‌گیری", color: "ring" },
  queued: { label: "در صف", color: "hold" },
  idle: { label: "آزاد", color: "idle" },
  offline: { label: "خاموش / ثبت نشده", color: "off" },
  unreachable: { label: "در دسترس نیست", color: "off" },
};

export function channelStatus(ch) {
  if (ch.app === "ChanSpy") return "talking";
  if (ch.app === "Queue" && !ch.bridged?.length) return "queued";
  if (ch.state === 6) {
    if (ch.hold) return "hold";
    if (!ch.bridged?.length && ch.direction !== "in" && /Dial/i.test(ch.app || "")) return "dialing";
    return "talking";
  }
  if (ch.state === 5) return "ringing";
  return ch.direction === "in" ? "ringing" : "dialing";
}

/** The party on the other end of a channel: {number, name, peer} */
export function otherParty(ch, channels, peers) {
  if (ch.app === "ChanSpy") return { number: "", name: "شنود تماس", peer: "" };
  const b = ch.bridged?.map((n) => channels[n]).find(Boolean);
  let number = "", name = "";
  if (ch.direction === "in") {
    number = digits(ch.connectedNum) || digits(b?.callerNum) || "";
    name = ch.connectedName || b?.callerName || "";
  } else {
    number = (ch.exten && ch.exten !== "s" && digits(ch.exten)) || digits(ch.connectedNum) || digits(b?.callerNum) || "";
    name = (ch.connectedName && ch.connectedName !== number ? ch.connectedName : "") || "";
  }
  if (!name && peers[number]?.callerName) name = peers[number].callerName;
  if (name === number) name = "";
  return { number, name, peer: b?.peer || "" };
}

/** Is this channel on a trunk (outside line)? */
export const isTrunkChannel = (ch, peers) => ch.tech === "DAHDI" || (ch.peer && peers[ch.peer]?.kind === "trunk");

export function buildExtensions(peers, channels) {
  const byPeer = {};
  for (const c of Object.values(channels)) if (c.peer) (byPeer[c.peer] ||= []).push(c);
  const order = { ringing: 0, talking: 1, hold: 2, queued: 2, dialing: 3, idle: 4 };
  return Object.values(peers).filter((p) => p.kind === "extension").map((p) => {
    const calls = (byPeer[p.name] || []).sort((a, b) => a.startedAt - b.startedAt);
    let status = calls.length ? calls.map(channelStatus).sort((a, b) => order[a] - order[b])[0] : "idle";
    if (!calls.length && (p.status === "offline" || p.status === "unreachable")) status = p.status;
    const external = calls.some((c) => c.bridged?.some((n) => channels[n] && isTrunkChannel(channels[n], peers)) || (c.direction === "out" && String(c.exten).length >= 5));
    return { ...p, calls, status, external };
  }).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

/** Active conversations, one row per call (grouped by bridge / linked channels). */
export function buildCalls(peers, channels, hideLocal = true) {
  const seen = new Set();
  const calls = [];
  const list = Object.values(channels).filter((c) => !(hideLocal && c.tech === "Local")).sort((a, b) => a.startedAt - b.startedAt);
  for (const c of list) {
    if (seen.has(c.name)) continue;
    const group = [c];
    seen.add(c.name);
    for (let i = 0; i < group.length; i++) for (const n of group[i].bridged || []) {
      if (!seen.has(n) && channels[n] && !(hideLocal && channels[n].tech === "Local")) { seen.add(n); group.push(channels[n]); }
    }
    calls.push(group);
  }
  return calls.map((g) => {
    const trunk = g.find((c) => isTrunkChannel(c, peers));
    const exts = g.filter((c) => peers[c.peer]?.kind === "extension");
    const first = g[0];
    const direction = !trunk ? "internal" : exts.some((e) => e.direction === "out") ? "outbound" : "inbound";
    const sts = g.map(channelStatus);
    const status = sts.includes("talking") ? "talking" : sts.includes("hold") ? "hold" : sts.includes("queued") && !sts.includes("ringing") ? "queued" : "ringing";
    return { id: first.name, channels: g, trunk, exts, direction, status, startedAt: first.startedAt, answeredAt: Math.max(...g.map((c) => c.answeredAt || 0)) };
  });
}
