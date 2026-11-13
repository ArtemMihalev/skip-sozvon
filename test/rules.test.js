import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, validate, isTeams, observe } from "../extension/rules.js";

test("only supported HTTPS Teams hosts are accepted", () => {
  for (const host of ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]) assert.equal(isTeams(`https://${host}/v2`), true);
  for (const url of ["http://teams.microsoft.com", "https://teams.microsoft.com.evil.test", "https://example.com", "garbage"]) assert.equal(isTeams(url), false);
});
test("rejects disabled rules, past deadlines, and invalid thresholds", () => {
  assert.throws(() => validate({ timed: false, drop: false }));
  assert.throws(() => validate({ timed: true, deadline: 999 }, 1000));
  for (const config of [{ percent: 0 }, { percent: 101 }, { minimum: 1.5 }, { windowSeconds: 0 }, { graceSeconds: 0 }, { selector: 123 }]) assert.throws(() => validate(config));
  assert.equal(validate({ timed: true, deadline: 2000 }, 1000).deadline, 2000);
});
function watcher(overrides = {}) {
  let state = { config: { ...DEFAULTS, ...overrides }, samples: [], candidate: null };
  return (count, seconds) => (state = { ...state, ...observe(state, count, seconds * 1000) });
}
test("drop must meet BOTH percentage and absolute limits", () => {
  const w = watcher();
  w(100, 0); assert.equal(w(97, 5).candidate, null);
  const small = watcher(); small(5, 0); assert.equal(small(3, 5).candidate, null);
  const exact = watcher(); exact(10, 0); assert.equal(exact(7, 5).candidate.peak, 10);
});
test("qualifying drop must remain confirmed for the grace period", () => {
  const w = watcher(); w(20, 0); w(14, 5);
  for (const t of [10, 15, 20, 25, 30]) assert.equal(w(14, t).hit, false);
  assert.equal(w(14, 35).hit, true);
});
test("recovery cancels countdown", () => {
  const w = watcher(); w(20, 0); w(14, 5);
  assert.equal(w(19, 10).candidate, null);
  assert.equal(w(14, 15).hit, false);
  assert.equal(w(14, 15).candidate.at, 15000);
});
test("missing, invalid, and stale counts cannot close a tab", () => {
  for (const invalid of [null, undefined, 0, -1, NaN, 1.5, 100001]) {
    const w = watcher(); w(20, 0); w(14, 5);
    assert.equal(w(invalid, 10).candidate, null);
    assert.equal(w(14, 15).candidate, null);
  }
  const w = watcher(); w(20, 0); w(14, 5);
  assert.equal(w(14, 40).candidate, null);
});
test("gradual decline outside the rolling window does not trigger", () => {
  const w = watcher({ windowSeconds: 15 }); w(20, 0);
  w(19, 10); w(18, 20); w(17, 30);
  assert.equal(w(14, 40).candidate, null);
});
test("confirmation keeps original reference across window boundary", () => {
  const w = watcher({ windowSeconds: 15 }); w(20, 0); w(14, 5);
  for (const t of [10, 15, 20, 25, 30]) w(14, t);
  assert.equal(w(14, 35).hit, true);
});
