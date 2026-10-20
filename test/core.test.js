import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseMessage, buildAction } from "../server/ami/client.js";
import { parsePhoneModel } from "../server/ami/phone-model.js";
import { parseChannel, Pbx } from "../server/ami/pbx.js";
import { normalizeNumber, parseCsv, toCsv, toJalaliString } from "../server/util.js";

test("parseMessage: repeated keys and legacy command output", () => {
  assert.deepEqual(parseMessage("Response: Success\r\nOutput: a\r\nOutput: b"), { Response: "Success", Output: ["a", "b"] });
  const legacy = parseMessage("Response: Follows\r\nPrivilege: Command\r\nActionID: p1\r\nline 1\n\nline 3\n--END COMMAND--");
  assert.equal(legacy.ActionID, "p1");
  assert.deepEqual(legacy.Output, ["line 1", "", "line 3"]);
});

test("buildAction: arrays become repeated keys, newlines stripped", () => {
  assert.equal(buildAction({ Action: "Originate", Variable: ["A=1", "B=2"], X: "a\r\nb" }), "Action: Originate\r\nVariable: A=1\r\nVariable: B=2\r\nX: a b\r\n\r\n");
});

test("parsePhoneModel", () => {
  assert.equal(parsePhoneModel("Yealink SIP-T21P_E2 52.84.0.15").model, "Yealink T21P E2");
  assert.equal(parsePhoneModel("Grandstream GXP1625 1.0.4.128").model, "Grandstream GXP1625");
  assert.equal(parsePhoneModel("Cisco/SPA504G-7.5.5").model, "Cisco SPA504G");
  assert.equal(parsePhoneModel("MicroSIP/3.21.3").type, "soft");
  assert.equal(parsePhoneModel("").type, "unknown");
});

test("parseChannel", () => {
  assert.deepEqual(parseChannel("SIP/101-0000001a"), { tech: "SIP", peer: "101" });
  assert.deepEqual(parseChannel("PJSIP/my-trunk-00000003"), { tech: "PJSIP", peer: "my-trunk" });
  assert.deepEqual(parseChannel("DAHDI/i1/0912-5"), { tech: "DAHDI", peer: "DAHDI" });
  assert.equal(parseChannel("Local/101@from-internal-00000001;1").peer, "");
});

test("normalizeNumber / csv / jalali", () => {
  assert.equal(normalizeNumber("+98 912 123 4567"), "09121234567");
  assert.equal(normalizeNumber("00989121234567"), "09121234567");
  assert.equal(normalizeNumber("9121234567"), "09121234567");
  assert.deepEqual(parseCsv('a,"b,c"\r\n1,"x""y"\n'), [["a", "b,c"], ["1", 'x"y']]);
  assert.equal(toCsv([["a", "b,c"]]), 'a,"b,c"');
  assert.equal(toJalaliString("2026-10-20 14:05:00"), "1405/07/28 14:05:00");
  assert.equal(toJalaliString("2026-03-21"), "1405/01/01");
});

function fakePbx() {
  const ami = new EventEmitter();
  ami.status = "connected"; ami.legacy = true; ami.info = () => ({});
  return new Pbx(ami, () => ({ extensionPattern: "^\\d{3}$" }));
}

test("Pbx: Asterisk 11 Dial/Bridge/Hangup", () => {
  const p = fakePbx();
  p.onEvent({ Event: "Newchannel", Channel: "SIP/trunk-01", ChannelState: "6", CallerIDNum: "09121234567", Uniqueid: "1" });
  p.onEvent({ Event: "Newchannel", Channel: "SIP/101-02", ChannelState: "0", CallerIDNum: "101", Uniqueid: "2" });
  p.onEvent({ Event: "Dial", SubEvent: "Begin", Channel: "SIP/trunk-01", Destination: "SIP/101-02", CallerIDNum: "09121234567", DestUniqueID: "2" });
  assert.equal(p.channels.get("SIP/101-02").direction, "in");
  assert.equal(p.channels.get("SIP/101-02").connectedNum, "09121234567");
  p.onEvent({ Event: "Newstate", Channel: "SIP/101-02", ChannelState: "6" });
  p.onEvent({ Event: "Bridge", Bridgestate: "Link", Channel1: "SIP/trunk-01", Channel2: "SIP/101-02" });
  assert.deepEqual(p.channels.get("SIP/101-02").bridged, ["SIP/trunk-01"]);
  assert.ok(p.channels.get("SIP/101-02").answeredAt > 0);
  p.onEvent({ Event: "Hangup", Channel: "SIP/trunk-01" });
  assert.deepEqual(p.channels.get("SIP/101-02").bridged, []);
  p.onEvent({ Event: "Hangup", Channel: "SIP/101-02" });
  assert.equal(p.channels.size, 0);
});

test("Pbx: Asterisk 13+ BridgeEnter/Hold, PeerStatus", () => {
  const p = fakePbx();
  p.upsertPeer("101", { status: "offline" });
  p.onEvent({ Event: "PeerStatus", Peer: "SIP/101", PeerStatus: "Registered", Address: "10.0.0.5:5060" });
  assert.equal(p.peers.get("101").status, "online");
  assert.equal(p.peers.get("101").ip, "10.0.0.5");
  p.onEvent({ Event: "Newchannel", Channel: "PJSIP/101-a", ChannelState: "4", Uniqueid: "1", Exten: "0912" });
  p.onEvent({ Event: "Newchannel", Channel: "PJSIP/tr-b", ChannelState: "0", Uniqueid: "2" });
  p.onEvent({ Event: "BridgeEnter", BridgeUniqueid: "x", Channel: "PJSIP/101-a" });
  p.onEvent({ Event: "BridgeEnter", BridgeUniqueid: "x", Channel: "PJSIP/tr-b" });
  assert.deepEqual(p.channels.get("PJSIP/101-a").bridged, ["PJSIP/tr-b"]);
  assert.equal(p.channels.get("PJSIP/101-a").direction, "out");
  p.onEvent({ Event: "Hold", Channel: "PJSIP/101-a" });
  assert.equal(p.channels.get("PJSIP/101-a").hold, true);
  p.onEvent({ Event: "Unhold", Channel: "PJSIP/101-a" });
  assert.equal(p.channels.get("PJSIP/101-a").hold, false);
  p.onEvent({ Event: "BridgeLeave", BridgeUniqueid: "x", Channel: "PJSIP/tr-b" });
  assert.deepEqual(p.channels.get("PJSIP/101-a").bridged, []);
});

import { inScope, cleanGroup } from "../server/access.js";
import { matchDialplan, checkDialplanList } from "../server/util.js";

test("dialplan patterns", () => {
  assert.ok(matchDialplan("_1XX", "150"));
  assert.ok(!matchDialplan("_1XX", "1500"));
  assert.ok(matchDialplan("_XXX, _NXXX", "2001"));
  assert.ok(matchDialplan("_[1-3]XX", "299"));
  assert.ok(!matchDialplan("_[1-3]XX", "499"));
  assert.ok(matchDialplan("_9.", "9021"));
  assert.throws(() => checkDialplanList("_1[2"));
});

test("access scopes", () => {
  const u = (scopes, extension = "104") => ({ isAdmin: false, extension, perms: [], scopes });
  assert.ok(inScope(u({ panel: { mode: "list", list: "101-103, _2XX" } }), "panel", "102"));
  assert.ok(inScope(u({ panel: { mode: "list", list: "101-103, _2XX" } }), "panel", "250"));
  assert.ok(!inScope(u({ panel: { mode: "list", list: "101-103, _2XX" } }), "panel", "104"));
  assert.ok(!inScope(u({ panel: { mode: "except", list: "_10X" } }), "panel", "105"));
  assert.ok(inScope(u({ calls: { mode: "self" } }), "calls", "104"));
  assert.ok(!inScope(u({ calls: { mode: "self" } }), "calls", "105"));
  assert.ok(inScope(u({ dial: { mode: "none" } }), "dial", "104"), "own extension always allowed for dialing");
  assert.ok(!inScope(u({ spy: { mode: "none" } }), "spy", "104"));
  assert.ok(inScope({ isAdmin: true }, "spy", "999"));
  assert.throws(() => cleanGroup({ name: "x", scopes: { panel: { mode: "list", list: "" } } }));
  assert.deepEqual(cleanGroup({ name: "x", permissions: ["panel.view", "bogus"] }).permissions, ["panel.view"]);
});
