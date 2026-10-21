// Live PBX state over WebSocket (snapshot + batched patches), exposed as a React hook.
import { useSyncExternalStore } from "react";

const EMPTY = { connected: false, ami: { status: "connecting" }, peers: {}, channels: {}, registrations: [], dahdi: [], queues: [] };
let state = { ...EMPTY, servers: null };
let serverId = 0;
const listeners = new Set();
let ws = null;
let retry = 1000;
let started = false;

const emit = () => listeners.forEach((l) => l());
const set = (patch) => { state = { ...state, ...patch }; emit(); };

function apply(items) {
  let peers = state.peers, channels = state.channels, extra = {};
  for (const it of items) {
    switch (it.type) {
      case "peer": peers = peers === state.peers ? { ...peers } : peers; peers[it.data.name] = it.data; break;
      case "peerDel": peers = peers === state.peers ? { ...peers } : peers; delete peers[it.name]; break;
      case "channel": channels = channels === state.channels ? { ...channels } : channels; channels[it.data.name] = it.data; break;
      case "channelDel": channels = channels === state.channels ? { ...channels } : channels; delete channels[it.name]; break;
      case "registrations": extra.registrations = it.data; break;
      case "dahdi": extra.dahdi = it.data; break;
      case "queues": extra.queues = it.data; break;
      case "ami": extra.ami = it.data; break;
      default: break;
    }
  }
  set({ peers, channels, ...extra });
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws${serverId ? `?server=${serverId}` : ""}`);
  const mine = ws;
  ws.onopen = () => { retry = 1000; };
  ws.onmessage = (m) => {
    if (mine !== ws) return;
    const msg = JSON.parse(m.data);
    if (msg.type === "servers") { set({ servers: msg.data }); return; }
    if (msg.type === "snapshot") {
      const d = msg.data;
      set({
        connected: true, ami: d.ami, registrations: d.registrations, dahdi: d.dahdi, queues: d.queues || [],
        peers: Object.fromEntries(d.peers.map((p) => [p.name, p])),
        channels: Object.fromEntries(d.channels.map((c) => [c.name, c])),
      });
    } else if (msg.type === "batch") apply(msg.items);
  };
  ws.onclose = () => {
    if (mine !== ws) return;
    set({ connected: false });
    if (!started) return;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

export function startLive(id) { serverId = Number(id) || 0; if (started) return; started = true; connect(); }
/** Follow another PBX server: drop the old feed and state, connect again. */
export function switchLive(id) {
  serverId = Number(id) || 0;
  set({ ...EMPTY });
  if (!started) return;
  const old = ws;
  connect();
  old?.close();
}
export function stopLive() { started = false; ws?.close(); }

export function useLive(selector = (s) => s) {
  return selector(useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state));
}

/** Ticks every second so call timers re-render. */
let now = Date.now();
const tickers = new Set();
setInterval(() => { now = Date.now(); tickers.forEach((l) => l()); }, 1000);
export function useNow() {
  return useSyncExternalStore((l) => { tickers.add(l); return () => tickers.delete(l); }, () => now);
}
