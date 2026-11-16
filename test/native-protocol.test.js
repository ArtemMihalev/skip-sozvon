import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const executable = fileURLToPath(new URL("../native/bin/Sozvon.ZoomHost.exe", import.meta.url));

test("compiled native host exchanges real Chrome frames without console noise or launching Zoom", { skip: process.platform !== "win32" || !existsSync(executable), timeout: 10000 }, async t => {
  const messages = [
    { requestId: "ping", command: "PING" },
    { requestId: "status", command: "STATUS" },
    { requestId: "invalid", command: "UNRECOGNIZED" },
    { requestId: "bad-start", command: "START", runId: "bad" }
  ];
  const input = Buffer.concat(messages.map(message => { const bytes = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); return Buffer.concat([header, bytes]); }));
  const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const chunks = []; let stderr = "";
  child.stdout.on("data", bytes => chunks.push(bytes)); child.stderr.on("data", bytes => { stderr += bytes; });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0); assert.equal(stderr, "");
  let bytes = Buffer.concat(chunks); const replies = [];
  while (bytes.length) { const size = bytes.readUInt32LE(); assert(size > 0 && size <= 1000000); replies.push(JSON.parse(bytes.subarray(4, 4 + size))); bytes = bytes.subarray(4 + size); }
  assert.equal(replies.length, 4); assert.equal(replies[0].requestId, "ping"); assert.equal(typeof replies[0].zoomInstalled, "boolean");
  assert.equal(replies[1].state.active, false); assert.equal(replies[2].ok, false); assert.equal(replies[3].ok, false);
  assert.match(replies[2].error, /Неизвестная команда/);
  t.diagnostic(`Помощник ${replies[0].version}; Zoom найден: ${replies[0].zoomInstalled ? "да" : "нет"}`);
});
