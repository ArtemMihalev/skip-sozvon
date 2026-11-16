import test from "node:test";
import assert from "node:assert/strict";

function event() {
  const listeners = new Set();
  return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit(...args) { for (const fn of [...listeners]) fn(...args); } };
}
test("scheduled background opens multiple tabs, tracks real entry, exits independently and restores future jobs", async () => {
  const realNow = Date.now; let now = new Date(2030, 0, 7, 10).getTime(); Date.now = () => now;
  let session = {}, local = {}, listener, nextTabId = 100;
  const tabs = new Map(), alarms = new Map(), phases = new Map(), removed = [];
  const onAlarm = event(), onRemoved = event(), onUpdated = event();
  globalThis.chrome = {
    storage: {
      session: { get: async () => structuredClone(session), set: async data => { session = { ...session, ...structuredClone(data) }; } },
      local: { get: async () => structuredClone(local), set: async data => { local = { ...local, ...structuredClone(data) }; } }
    },
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, onStartup: event(), onInstalled: event() },
    alarms: { onAlarm, get: async name => alarms.get(name), create: async (name, data) => alarms.set(name, { name, scheduledTime: data.when, ...data }), clear: async name => alarms.delete(name), getAll: async () => [...alarms.values()] },
    tabs: {
      onRemoved, onUpdated,
      create: async ({ url }) => { const tab = { id: nextTabId++, url, title: "Teams" }; tabs.set(tab.id, tab); return tab; },
      get: async id => { if (!tabs.has(id)) throw Error("missing"); return { ...tabs.get(id) }; },
      sendMessage: async (id, message) => {
        const tab = tabs.get(id); if (!tab) throw Error("missing");
        if (message.type === "AUTO_JOIN") return { url: tab.url, phase: phases.get(id) || "joining", status: "Simulated Teams state" };
        if (message.type === "READ") return { url: tab.url, count: 20, source: "Counter" };
        return { ok: true };
      }
    },
    debugger: { attach: async () => {}, detach: async () => {}, onEvent: event(), onDetach: event(), sendCommand: async ({ tabId }, method) => { if (method === "Page.close") { removed.push(tabId); tabs.delete(tabId); onRemoved.emit(tabId); } } }
  };
  const send = (message, sender = {}) => new Promise(resolve => listener(message, sender, resolve));
  try {
    await import("../extension/background.js?scheduled-integration");
    const add = (name, minutes) => send({ type: "SCHEDULE_ADD", schedule: { title: name, url: `https://teams.microsoft.com/meet/${name}`, joinAt: now + 60000, repeat: "weekly", config: { drop: true, timed: true, deadline: now + minutes * 60000 } } });
    const first = await add("First", 2); const second = await add("Second", 3);
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    now += 60000; onAlarm.emit({ name: "sozvon-join:" + first.job.id });
    let status = await send({ type: "STATUS" });
    assert.equal(status.watches.length, 2); assert.equal(tabs.size, 2);
    onAlarm.emit({ name: "sozvon-join:" + second.job.id }); await send({ type: "STATUS" }); assert.equal(tabs.size, 2);
    const a = status.watches.find(w => w.scheduleId === first.job.id), b = status.watches.find(w => w.scheduleId === second.job.id);
    tabs.get(a.tabId).url = "https://teams.microsoft.com/v2/call-first";
    onUpdated.emit(a.tabId, { url: tabs.get(a.tabId).url });
    phases.set(a.tabId, "lobby"); phases.set(b.tabId, "joined");
    await send({ type: "TICK" }); status = await send({ type: "STATUS" });
    assert.equal(status.watches.find(w => w.tabId === a.tabId).phase, "joining");
    assert.equal(status.watches.find(w => w.tabId === a.tabId).count, null);
    assert.equal(status.watches.find(w => w.tabId === b.tabId).phase, "watching");
    phases.set(a.tabId, "joined"); now += 5000; await send({ type: "TICK" });
    assert.equal((await send({ type: "STATUS" })).watches.find(w => w.tabId === a.tabId).count, 20);
    now += 55000; await send({ type: "TICK" });
    assert.deepEqual(removed, [a.tabId]);
    assert.equal((await send({ type: "STATUS" })).watches.length, 1);
    assert(alarms.has("sozvon-check"));
    await send({ type: "STOP" }, { tab: { id: b.tabId } });
    assert.equal((await send({ type: "STATUS" })).watches.length, 0); assert.equal(tabs.size, 1);
    session = {}; alarms.clear();
    await import("../extension/background.js?scheduled-browser-restart");
    status = await send({ type: "STATUS" });
    assert.equal(status.schedules.length, 2); assert.equal(status.watches.length, 0);
    assert(alarms.has("sozvon-join:" + first.job.id)); assert.equal(tabs.size, 1);
    await send({ type: "SCHEDULE_REMOVE", id: first.job.id });
    assert.equal((await send({ type: "STATUS" })).schedules.length, 1);
    assert(!alarms.has("sozvon-join:" + first.job.id));
  } finally { Date.now = realNow; delete globalThis.chrome; }
});
