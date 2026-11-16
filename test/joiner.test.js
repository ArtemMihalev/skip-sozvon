import test from "node:test";
import assert from "node:assert/strict";
import "../extension/joiner.js";
const { step } = globalThis.SozvonJoiner;
function element(label = "", attrs = {}) {
  return { clicks: 0, textContent: label, attrs, getClientRects: () => [{}], getAttribute(key) { return this.attrs[key] ?? null; }, click() { this.clicks++; } };
}
function doc({ roster, hangup, join, camera, mic, name, buttons = [], body = "", login = false } = {}) {
  class Input {}
  // The actual input object has its own value; emulate the native setter.
  Object.defineProperty(Input.prototype, "value", { set(value) { this.stored = value; }, get() { return this.stored || ""; } });
  return { body: { innerText: body }, defaultView: { HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } } }, querySelectorAll(selector) {
    if (selector.includes("roster-button")) return roster ? [roster] : [];
    if (selector.includes("hangup-button")) return hangup ? [hangup] : [];
    if (selector.includes('input[type="password"]')) return login ? [element()] : [];
    if (selector === 'button, a, [role="button"]') return buttons;
    if (selector.includes("prejoin-join-button")) return join ? [join] : [];
    if (selector.includes("toggle-video")) return camera ? [camera] : [];
    if (selector.includes("toggle-mute")) return mic ? [mic] : [];
    if (selector.includes("prejoin-display-name-input")) return name ? [name] : [];
    return [];
  } };
}
test("connected status requires actual meeting controls; opens roster once", () => {
  const roster = element("People"); const d = doc({ roster, hangup: element("Leave") });
  assert.equal(step(d).phase, "joined"); step(d); assert.equal(roster.clicks, 1);
  assert.notEqual(step(doc({ hangup: element("Leave") })).phase, "joined");
});
test("fills guest name even when Join is initially disabled", () => {
  const join = element("Join now"); join.disabled = true;
  const name = element(); name.value = "";
  name.dispatchEvent = function() { this.value = this.stored; join.disabled = false; };
  const d = doc({ join, name, camera: element("Turn camera on"), mic: element("Unmute microphone") });
  assert.equal(step(d, { guestName: "Test Guest" }, 0).phase, "joining");
  assert.equal(name.value, "Test Guest"); assert.equal(join.clicks, 1);
});
test("guest entry with no supplied name asks for attention", () => {
  const join = element("Join now"), name = element(); name.value = "";
  assert.equal(step(doc({ join, name }), {}, 0).phase, "attention");
  assert.equal(join.clicks, 0);
});
test("lobby and authentication are never reported as successful entry", () => {
  assert.equal(step(doc({ body: "Someone will let you in soon" })).phase, "lobby");
  assert.equal(step(doc({ login: true })).phase, "attention");
});
test("browser chooser uses the web option and limits repeated clicks", () => {
  const web = element("Continue on this browser"); const d = doc({ buttons: [element("Open Teams app"), web] });
  step(d, {}, 0); step(d, {}, 5000); assert.equal(web.clicks, 1);
  step(d, {}, 10000); assert.equal(web.clicks, 2);
});
test("prejoin never submits while camera or microphone state is unknown", () => {
  const join = element("Join now");
  assert.equal(step(doc({ join })).phase, "attention"); assert.equal(join.clicks, 0);
});
test("turns media off before joining, and waits for meeting controls", () => {
  const join = element("Join now"); const camera = element("Camera", { "aria-checked": "true" });
  camera.click = function() { this.clicks++; this.attrs["aria-checked"] = "false"; };
  const mic = element("Unmute microphone"); const d = doc({ join, camera, mic });
  assert.equal(step(d, {}, 0).phase, "attention"); assert.equal(camera.clicks, 1); assert.equal(join.clicks, 0);
  assert.equal(step(d, {}, 5000).phase, "joining"); assert.equal(join.clicks, 1);
  step(d, {}, 6000); assert.equal(join.clicks, 1);
});
