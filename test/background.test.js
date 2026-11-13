import test from "node:test";
import assert from "node:assert/strict";

test("background targets one tab, survives worker reload, and disarms safely", async () => {
  const realNow = Date.now;
  let now = 1000000;
  Date.now = () => now;
  let store = {};
  let messageHandler;
  const alarms = new Map();
  const removed = [];
  let tab = { id: 17, url: "https://teams.microsoft.com/v2/meeting", title: "Test meeting" };
  let count = 20;
  const event = () => {
    const listeners = new Set();
    return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit(...args) { for (const fn of [...listeners]) fn(...args); } };
  };
  const onRemoved = event();
  globalThis.chrome = {
    storage: { session: { get: async () => structuredClone(store), set: async value => { store = { ...store, ...structuredClone(value) }; } } },
    runtime: { onMessage: { addListener(fn) { messageHandler = fn; } } },
    alarms: { get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: event() },
    tabs: { get: async id => { if (id !== tab.id) throw Error("missing"); return { ...tab }; }, sendMessage: async (id, msg) => msg.type === "READ" ? { count, url: tab.url, source: "Test" } : { ok: true }, onRemoved, onUpdated: event() },
    debugger: { attach: async () => {}, detach: async () => {}, onEvent: event(), onDetach: event(), sendCommand: async (target, method) => { if (method === "Page.close") { removed.push(target.tabId); onRemoved.emit(target.tabId); } } }
  };
  const send = (message, sender = {}) => new Promise(resolve => messageHandler(message, sender, resolve));
  const start = config => send({ type: "START", tabId: 17, config });
  try {
    await import("../extension/background.js?initial");
    assert.equal((await start({ timed: true, drop: false, deadline: now + 10000 })).ok, true);
    now += 9000; await send({ type: "TICK" }); assert.deepEqual(removed, []);
    // Reimport models worker termination: state and deadline must survive.
    alarms.clear();
    await import("../extension/background.js?restarted");
    await send({ type: "STATUS" });
    assert.equal(alarms.has("sozvon-deadline"), true);
    now += 1000; await send({ type: "TICK" }); assert.deepEqual(removed, [17]);
    await send({ type: "TICK" }); assert.deepEqual(removed, [17]);

    await start({ timed: true, drop: false, deadline: now + 1000 });
    tab.url = "https://teams.microsoft.com/v2/another-meeting";
    now += 2000; await send({ type: "TICK" });
    assert.equal((await send({ type: "STATUS" })).state.active, false);
    assert.deepEqual(removed, [17]);

    await start({ drop: true });
    const foreign = await send({ type: "STOP" }, { tab: { id: 18 } });
    assert.equal(foreign.ok, false);
    now += 5000; count = 14; await send({ type: "TICK" });
    for (let i = 0; i < 6; i++) { now += 5000; await send({ type: "TICK" }); }
    assert.deepEqual(removed, [17, 17]);

    count = 20; await start({ drop: true });
    now += 5000; count = null; await send({ type: "TICK" });
    now += 5000; count = 1; await send({ type: "TICK" });
    assert.deepEqual(removed, [17, 17]);
    assert.equal((await send({ type: "STOP" }, { tab: { id: 17 } })).ok, true);
    assert.equal((await send({ type: "STATUS" })).state.active, false);

    globalThis.chrome.debugger.attach = async () => { throw Error("Already attached"); };
    await start({ timed: true, drop: false, deadline: now + 1000 });
    now += 2000; await send({ type: "TICK" });
    const failed = (await send({ type: "STATUS" })).state;
    assert.equal(failed.active, false);
    assert.match(failed.status, /Не удалось подтвердить закрытие/);
    assert.deepEqual(removed, [17, 17]);
  } finally { Date.now = realNow; delete globalThis.chrome; }
});
