import test from "node:test";
import assert from "node:assert/strict";
import "../extension/reader.js";
const { parse, read } = globalThis.SozvonReader;
const node = (text, tid = "", label = null, visible = true) => ({ textContent: text, getAttribute: key => key === "data-tid" ? tid : label, getClientRects: () => visible ? [{}] : [] });
const doc = nodes => ({ querySelectorAll: () => nodes });
test("parses only one positive number", () => {
  assert.equal(parse("Участники (24)"), 24);
  for (const text of ["", "Участники", "0", "24 из 30", "1,000"]) assert.equal(parse(text), null);
});
test("reads explicit Teams counters and in-meeting headings", () => {
  assert.equal(read(doc([node("Участники (20)", "roster-button")])).count, 20);
  assert.equal(read(doc([node("В этом собрании (15)")])).count, 15);
  assert.equal(read(doc([node("In this meeting (18)")])).count, 18);
});
test("ignores invited, hidden counters, ambiguous totals, and arbitrary headings", () => {
  for (const nodes of [[node("Приглашены (20)")], [node("Invited (20)", "participant-count")], [node("20", "participant-count", null, false)], [node("20", "participant-count"), node("21", "participant-count")], [node("Participants (30)")]]) assert.equal(read(doc(nodes)).count, null);
});
test("custom selector requires exactly one element and one number", () => {
  assert.equal(read(doc([node("42")]), "#counter").count, 42);
  assert.equal(read(doc([node("42"), node("43")]), "#counter").count, null);
  assert.equal(read({ querySelectorAll: () => { throw Error("invalid"); } }, "[").count, null);
});
