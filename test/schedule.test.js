import test from "node:test";
import assert from "node:assert/strict";
import { validateSchedule, nextOccurrence, createScheduler, LATE_LIMIT } from "../extension/schedule.js";

const now = new Date(2030, 0, 7, 10, 0).getTime(); // Monday, local clock.
const input = (overrides = {}) => ({ url: "https://teams.microsoft.com/l/meetup-join/test", joinAt: now + 60000, repeat: "weekly", config: { drop: true }, ...overrides });
function fixture() {
  let storage = {};
  const alarms = new Map();
  const launches = [];
  let blocked = false, fail = false;
  const api = {
    storage: { local: { get: async () => structuredClone(storage), set: async value => { storage = { ...storage, ...structuredClone(value) }; } } },
    alarms: { get: async name => alarms.get(name), getAll: async () => [...alarms.values()], create: async (name, value) => alarms.set(name, { name, scheduledTime: value.when, ...value }), clear: async name => alarms.delete(name) }
  };
  const scheduler = createScheduler(api, async (job, config) => { launches.push({ job: structuredClone(job), config }); if (fail) throw Error("Network"); }, async () => blocked);
  return { scheduler, alarms, launches, block: () => { blocked = true; }, fail: () => { fail = true; }, api };
}
test("schedule validation rejects non-Teams links, past dates, unsafe URL credentials, and exit before entry", () => {
  assert.equal(validateSchedule(input(), now).repeat, "weekly");
  for (const value of [input({ url: "https://example.com" }), input({ url: "https://teams.microsoft.com/" }), input({ url: "https://name:password@teams.microsoft.com/meet/123" }), input({ joinAt: now }), input({ repeat: "hourly" }), input({ config: { timed: true, deadline: now + 30000 } })]) assert.throws(() => validateSchedule(value, now));
});
test("recurrence uses local calendar dates, skips weekends and missed weeks", () => {
  const friday = new Date(2030, 0, 11, 10).getTime();
  assert.equal(new Date(nextOccurrence(friday, "weekdays", friday)).getDay(), 1);
  assert.equal(nextOccurrence(now, "once", now), null);
  const next = new Date(nextOccurrence(now, "weekly", now + 10 * 86400000));
  assert.equal(next.getDay(), 1); assert.equal(next.getDate(), 21); assert.equal(next.getHours(), 10);
});
test("due launches once, advances weekly time and shifts timed exit for each occurrence", async () => {
  const realNow = Date.now; let clock = now; Date.now = () => clock;
  try {
    const { scheduler, launches, alarms } = fixture();
    const job = await scheduler.add(input({ config: { timed: true, deadline: now + 3660000 } }));
    clock = job.joinAt; await scheduler.due(); await scheduler.due();
    assert.equal(launches.length, 1); assert.equal(launches[0].config.deadline, job.joinAt + 3600000);
    const nextAt = (await scheduler.list())[0].nextAt;
    clock = nextAt; await scheduler.due();
    assert.equal(launches.length, 2); assert.equal(launches[1].config.deadline, nextAt + 3600000);
    assert.equal(alarms.has("sozvon-join:" + job.id), true);
  } finally { Date.now = realNow; }
});
test("browser restart restores alarms but never duplicates a claimed occurrence", async () => {
  const realNow = Date.now; let clock = now; Date.now = () => clock;
  try {
    const f = fixture(); const job = await f.scheduler.add(input());
    f.alarms.clear(); await f.scheduler.restore(); assert(f.alarms.has("sozvon-join:" + job.id));
    clock = job.joinAt; await f.scheduler.due();
    const restarted = createScheduler(f.api, async () => { throw Error("Duplicate launch"); }, async () => false);
    f.alarms.clear(); await restarted.restore();
    assert.equal(f.launches.length, 1); assert.match((await restarted.list())[0].lastStatus, /Вкладка открыта/);
  } finally { Date.now = realNow; }
});
test("late and overlapping occurrences are skipped, with future repetition intact", async () => {
  const realNow = Date.now; let clock = now; Date.now = () => clock;
  try {
    const f = fixture(); const job = await f.scheduler.add(input());
    clock = job.joinAt + LATE_LIMIT + 1; await f.scheduler.due();
    assert.equal(f.launches.length, 0); assert.match((await f.scheduler.list())[0].lastStatus, /пропущен/);
    clock = (await f.scheduler.list())[0].nextAt; f.block(); await f.scheduler.due();
    assert.equal(f.launches.length, 0); assert.equal((await f.scheduler.list())[0].enabled, true);
  } finally { Date.now = realNow; }
});
test("one-off completes, pause cancels launch, remove clears alarm, failures are not blindly retried", async () => {
  const realNow = Date.now; let clock = now; Date.now = () => clock;
  try {
    const f = fixture(); const once = await f.scheduler.add(input({ repeat: "once" }));
    await f.scheduler.toggle(once.id); clock = once.joinAt; await f.scheduler.due(); assert.equal(f.launches.length, 0);
    await assert.rejects(f.scheduler.toggle(once.id), /время уже прошло/);
    await f.scheduler.remove(once.id); assert.equal((await f.scheduler.list()).length, 0); assert(!f.alarms.has("sozvon-join:" + once.id));
    clock = now; const job = await f.scheduler.add(input({ repeat: "once" }));
    f.fail(); clock = job.joinAt; await f.scheduler.due(); await f.scheduler.due();
    assert.equal(f.launches.length, 1); assert.equal((await f.scheduler.list())[0].enabled, false);
    assert.match((await f.scheduler.list())[0].lastStatus, /Network/);
  } finally { Date.now = realNow; }
});
test("independent meetings due together each launch once", async () => {
  const realNow = Date.now; let clock = now; Date.now = () => clock;
  try {
    const f = fixture(); await f.scheduler.add(input()); await f.scheduler.add(input({ title: "Second", url: "https://teams.microsoft.com/meet/second" }));
    clock += 60000; await f.scheduler.due(); assert.equal(f.launches.length, 2);
    assert.notEqual(f.launches[0].job.id, f.launches[1].job.id);
  } finally { Date.now = realNow; }
});
