import test from "node:test";
import assert from "node:assert/strict";
function event() { const set = new Set(); return { addListener(fn) { set.add(fn); }, removeListener(fn) { set.delete(fn); }, emit(...args) { for (const fn of [...set]) fn(...args); } }; }

test("Zoom schedule uses native app, relays counts, and stops without closing Teams or ending a meeting", async () => {
  const realNow = Date.now; let now = new Date(2030, 0, 7, 10).getTime(); Date.now = () => now;
  let local = {}, session = {}, listener, native = { active: false }, installed = true;
  const alarms = new Map(), commands = [], onAlarm = event();
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) {
    commands.push(message.command);
    queueMicrotask(() => {
      let response = {};
      if (message.command === "PING") response = { version: "0.4.0", zoomInstalled: installed };
      if (message.command === "START") native = { runId: message.runId, active: true, phase: "joining", status: "Starting Zoom", count: null, at: now };
      if (message.command === "STOP") { assert.equal(message.runId, native.runId); native = { ...native, active: false, phase: "done" }; }
      if (["START", "STOP", "STATUS"].includes(message.command)) response = { state: { ...native } };
      port.onMessage.emit({ ...response, type: "reply", requestId: message.requestId, ok: true });
    });
  } };
  globalThis.chrome = {
    storage: {
      local: { get: async () => structuredClone(local), set: async data => { local = { ...local, ...structuredClone(data) }; } },
      session: { get: async () => structuredClone(session), set: async data => { session = { ...session, ...structuredClone(data) }; } }
    },
    runtime: { connectNative: () => port, onMessage: { addListener(fn) { listener = fn; } }, onStartup: event(), onInstalled: event() },
    alarms: { onAlarm, get: async key => alarms.get(key), getAll: async () => [...alarms.values()], clear: async key => alarms.delete(key), create: async (name, data) => alarms.set(name, { name, scheduledTime: data.when, ...data }) },
    tabs: { create: () => { throw Error("Zoom must not open a browser tab"); }, sendMessage: () => { throw Error("No browser tab for native Zoom"); }, onRemoved: event(), onUpdated: event() }
  };
  const send = message => new Promise(resolve => listener(message, {}, resolve));
  try {
    await import("../extension/background.js?zoom-integration");
    const ping = await send({ type: "ZOOM_PING" }); assert.equal(ping.helper.zoomInstalled, true);
    const schedule = { provider: "zoom", zoomPrepared: true, url: "https://zoom.us/j/12345678901?pwd=abc", joinAt: now + 60000, repeat: "weekly", config: { timed: true, deadline: now + 3600000, drop: true } };
    installed = false; assert.equal((await send({ type: "SCHEDULE_ADD", schedule })).ok, false); installed = true;
    const added = await send({ type: "SCHEDULE_ADD", schedule }); assert.equal(added.ok, true);
    now += 60000; onAlarm.emit({ name: "sozvon-join:" + added.job.id });
    let status = await send({ type: "STATUS" }); assert.equal(status.watches.length, 1); assert.equal(status.watches[0].provider, "zoom"); assert(commands.includes("START"));
    native = { ...native, phase: "watching", status: "Connected", count: 23, at: now };
    port.onMessage.emit({ type: "status", state: native }); status = await send({ type: "STATUS" }); assert.equal(status.watches[0].count, 23);
    const key = status.watches[0].watchKey;
    await send({ type: "SCHEDULE_TOGGLE", id: added.job.id }); assert.equal((await send({ type: "STATUS" })).watches.length, 1);
    await send({ type: "STOP", watchKey: key }); assert.equal((await send({ type: "STATUS" })).watches.length, 0); assert(commands.includes("STOP")); assert(!commands.includes("LEAVE"));
    // A delayed old status cannot reactivate a stopped watch.
    port.onMessage.emit({ type: "status", state: { ...native, active: true } }); assert.equal((await send({ type: "STATUS" })).watches.length, 0);
    now += 60000; schedule.joinAt = now + 60000;
    const next = await send({ type: "SCHEDULE_ADD", schedule }); now += 60000; onAlarm.emit({ name: "sozvon-join:" + next.job.id }); await send({ type: "STATUS" });
    port.onDisconnect.emit(); status = await send({ type: "STATUS" }); assert.equal(status.watches.length, 0); assert.match(status.schedules.find(j => j.id === next.job.id).lastStatus, /недоступен/);
  } finally { Date.now = realNow; delete globalThis.chrome; }
});
