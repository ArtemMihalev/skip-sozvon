import test from "node:test";
import assert from "node:assert/strict";
import { ZoomBridge, parseZoomLink } from "../extension/zoom.js";
import { validateSchedule } from "../extension/schedule.js";

test("Zoom accepts full invitation links and rejects spoofed hosts, custom schemes and commands", () => {
  assert.equal(parseZoomLink("https://us02web.zoom.us/j/12345678901?pwd=abc").meetingId, "12345678901");
  for (const url of ["https://zoom.us.evil.test/j/12345678901", "https://user@zoom.us/j/12345678901", "zoommtg://zoom.us/join?confno=12345678901", "https://zoom.us/my/name", "https://zoom.us/j/123", "file:///Zoom.exe"]) assert.throws(() => parseZoomLink(url));
});
test("Zoom schedule requires confirmed initial media setup and preserves provider", () => {
  const now = Date.now();
  const input = { provider: "zoom", url: "https://zoom.us/j/12345678901", joinAt: now + 60000, repeat: "weekly", config: { drop: true } };
  assert.throws(() => validateSchedule(input, now), /Настройте|настройте/);
  assert.equal(validateSchedule({ ...input, zoomPrepared: true }, now).provider, "zoom");
});
function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } }; }
test("native bridge correlates replies, forwards status, and rejects pending requests on disconnect", async () => {
  const port = { onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); } };
  const api = { runtime: { connectNative: host => { assert.equal(host, "com.sozvon.zoom"); return port; } } };
  const states = [], errors = []; const bridge = new ZoomBridge(api, state => states.push(state), error => errors.push(error));
  const ping = bridge.request("PING");
  port.onMessage.emit({ type: "reply", requestId: "unknown", ok: true });
  port.onMessage.emit({ type: "reply", requestId: port.sent[0].requestId, ok: true, version: "0.4.0" });
  assert.equal((await ping).version, "0.4.0");
  port.onMessage.emit({ type: "status", state: { active: true, runId: "test" } }); assert.equal(states.length, 1);
  const start = bridge.request("START");
  port.onMessage.emit({ type: "reply", requestId: port.sent[1].requestId, ok: false, error: "Busy" }); await assert.rejects(start, /Busy/);
  const waiting = bridge.request("STATUS"); port.onDisconnect.emit(); await assert.rejects(waiting, /недоступен/);
  assert.equal(errors.length, 1); assert.equal(bridge.pending.size, 0);
});
