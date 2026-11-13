import test from "node:test";
import assert from "node:assert/strict";
import { closeTabWithConfirmation } from "../extension/close-tab.js";

function event() {
  const listeners = new Set();
  return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit(...args) { for (const fn of [...listeners]) fn(...args); }, get size() { return listeners.size; } };
}
function fixture(mode = "dialog") {
  const calls = [];
  const onEvent = event(), onDetach = event(), onRemoved = event();
  const source = { tabId: 17 };
  const api = {
    tabs: { get: async () => ({ url: "https://teams.microsoft.com/call" }), onRemoved },
    debugger: {
      onEvent, onDetach,
      attach: async (...args) => { calls.push(["attach", ...args]); if (mode === "attach-error") throw Error("Already attached"); },
      detach: async (...args) => calls.push(["detach", ...args]),
      sendCommand: async (target, method, params) => {
        calls.push([method, target, params]);
        if (method === "Page.close") {
          if (mode === "no-dialog") onRemoved.emit(17);
          if (mode === "dialog") {
            onEvent.emit({ tabId: 18 }, "Page.javascriptDialogOpening", { type: "beforeunload" });
            onEvent.emit(source, "Page.javascriptDialogOpening", { type: "confirm" });
            onEvent.emit(source, "Page.javascriptDialogOpening", { type: "alert" });
            onEvent.emit(source, "Page.javascriptDialogOpening", { type: "beforeunload" });
          }
          if (mode === "detach") onDetach.emit(source, "canceled_by_user");
          if (mode === "close-error") throw Error("Protocol error");
        }
        if (method === "Page.handleJavaScriptDialog") {
          if (mode === "dialog") { onDetach.emit(source, "target_closed"); onRemoved.emit(17); }
        }
      }
    }
  };
  const clean = () => { assert.equal(onEvent.size + onDetach.size + onRemoved.size, 0); };
  return { api, calls, clean };
}
const url = "https://teams.microsoft.com/call";
test("accepts only the target's beforeunload confirmation and detaches", async () => {
  const { api, calls, clean } = fixture();
  await closeTabWithConfirmation(api, 17, url);
  assert.deepEqual(calls.filter(c => c[0] === "Page.handleJavaScriptDialog"), [["Page.handleJavaScriptDialog", { tabId: 17 }, { accept: true }]]);
  assert.equal(calls.at(-1)[0], "detach");
  clean();
});
test("also closes tabs that have no confirmation", async () => {
  const { api, calls, clean } = fixture("no-dialog");
  await closeTabWithConfirmation(api, 17, url);
  assert.equal(calls.some(c => c[0] === "Page.handleJavaScriptDialog"), false);
  clean();
});
test("does not close a tab whose URL changed while attaching", async () => {
  const { api, calls, clean } = fixture();
  api.tabs.get = async () => ({ url: "https://teams.microsoft.com/other" });
  await assert.rejects(closeTabWithConfirmation(api, 17, url), /Адрес/);
  assert.equal(calls.some(c => c[0] === "Page.close"), false);
  clean();
});
test("attachment failure leaves the tab untouched", async () => {
  const { api, calls, clean } = fixture("attach-error");
  await assert.rejects(closeTabWithConfirmation(api, 17, url), /Already attached/);
  assert.deepEqual(calls.map(c => c[0]), ["attach"]);
  clean();
});
test("detach and protocol errors are failures, with cleanup", async () => {
  for (const mode of ["detach", "close-error"]) {
    const { api, calls, clean } = fixture(mode);
    await assert.rejects(closeTabWithConfirmation(api, 17, url));
    assert.equal(calls.at(-1)[0], "detach");
    clean();
  }
});
test("command success without actual tab removal times out", async () => {
  const { api, calls, clean } = fixture("never-closed");
  await assert.rejects(closeTabWithConfirmation(api, 17, url, 25), /не подтвердил закрытие/);
  assert.equal(calls.at(-1)[0], "detach");
  clean();
});
