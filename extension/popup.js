import { DEFAULTS, isTeams } from "./rules.js";
const $ = id => document.getElementById(id);
const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw Error(result?.error || "Не удалось выполнить команду"); return result; };
let state;
let busy = false;
async function refreshTabs() {
  const previous = $("tab").value;
  const tabs = (await chrome.tabs.query({})).filter(t => isTeams(t.url));
  $("tab").replaceChildren();
  for (const tab of tabs) { const option = document.createElement("option"); option.value = tab.id; option.textContent = tab.title || "Microsoft Teams"; $("tab").append(option); }
  const preferred = previous || String(state?.active ? state.tabId : tabs.find(t => t.active)?.id ?? tabs[0]?.id ?? "");
  if (tabs.some(t => String(t.id) === preferred)) $("tab").value = preferred;
  if (!tabs.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "Откройте конференцию Teams в Chrome"; $("tab").append(option); }
}
async function status() {
  state = (await send({ type: "STATUS" })).state;
  $("status").textContent = state?.status || "Автозакрытие выключено";
  $("details").textContent = state?.active ? `${state.title || "Teams"}${state.config.timed ? " · до " + new Date(state.config.deadline).toLocaleString() : ""}` : "Выберите вкладку и условия закрытия.";
  const stale = !state?.lastReadAt || Date.now() - state.lastReadAt > 20000;
  $("count").textContent = state?.active && state.config.drop ? (!stale && Number.isInteger(state.count) ? `Участников: ${state.count} · ${state.source}` : stale ? "Ждём актуальное число участников…" : state.source) : "";
  $("stop").disabled = !state?.active;
}
function populate(config) {
  for (const key of ["timed", "drop"]) $(key).checked = config[key];
  for (const key of ["percent", "minimum", "windowSeconds", "graceSeconds"]) $(key).value = config[key];
  const date = new Date(config.deadline || Date.now() + 3600000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  $("deadline").value = local.toISOString().slice(0, 16);
}
async function run(fn) {
  if (busy) return; busy = true; $("error").textContent = ""; $("start").disabled = true;
  try { await fn(); await status(); } catch (e) { $("error").textContent = e.message; }
  finally { busy = false; $("start").disabled = false; }
}
$("form").onsubmit = event => { event.preventDefault(); run(async () => {
  const config = { timed: $("timed").checked, drop: $("drop").checked, deadline: new Date($("deadline").value).getTime(), selector: "" };
  for (const key of ["percent", "minimum", "windowSeconds", "graceSeconds"]) config[key] = Number($(key).value);
  const tabId = Number($("tab").value);
  if (!tabId) throw Error("Откройте вкладку Teams.");
  // Also support tabs opened before the extension was installed.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["reader.js", "content.js"] });
  await send({ type: "START", tabId, config });
  await chrome.storage.local.set({ preferences: { ...config, deadline: null } });
}); };
$("stop").onclick = () => run(() => send({ type: "STOP" }));
$("refresh").onclick = () => run(refreshTabs);
try {
  await status();
  populate(state?.active ? state.config : { ...DEFAULTS, ...(await chrome.storage.local.get("preferences")).preferences });
  await refreshTabs();
} catch (e) { $("error").textContent = e.message; }
setInterval(() => { if (!busy) status().catch(e => { $("error").textContent = e.message; }); }, 2000);
