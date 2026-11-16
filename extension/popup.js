import { DEFAULTS, isTeams } from "./rules.js";
const $ = id => document.getElementById(id);
const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw Error(result?.error || "Не удалось выполнить команду"); return result; };
let state;
let activeWatches = [];
let schedules = [];
let busy = false;
const repeatLabels = { once: "Один раз", weekly: "Еженедельно", daily: "Ежедневно", weekdays: "По будням" };
const formatDate = at => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
function action(label, fn) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = label;
  button.onclick = () => run(fn); return button;
}
function renderLists() {
  const fragment = document.createDocumentFragment();
  for (const job of schedules) {
    const card = document.createElement("article"); card.className = "job";
    const title = document.createElement("strong"); title.textContent = job.title;
    const next = document.createElement("p"); next.textContent = `${job.provider === "zoom" ? "Zoom" : "Teams"} · ${repeatLabels[job.repeat]} · ${job.enabled ? "Вход " + formatDate(job.nextAt) : "Выключено"}`;
    const result = document.createElement("p"); result.textContent = job.lastStatus;
    const exit = document.createElement("p");
    const conditions = [];
    if (job.config.timed) conditions.push(`через ${job.exitOffset / 60000} мин после времени входа`);
    if (job.config.drop) conditions.push(`отток ${job.config.percent}% и ${job.config.minimum} чел. за ${job.config.windowSeconds} сек., подтверждение ${job.config.graceSeconds} сек.`);
    exit.textContent = "Выход: " + conditions.join(" или ");
    const buttons = document.createElement("div"); buttons.className = "row";
    buttons.append(action(job.enabled ? "Приостановить" : "Включить", () => send({ type: "SCHEDULE_TOGGLE", id: job.id })), action("Удалить", () => send({ type: "SCHEDULE_REMOVE", id: job.id })));
    card.append(title, next, exit, result, buttons); fragment.append(card);
  }
  if (!schedules.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Добавьте ссылку и время первого входа. Дальше вкладка будет открываться сама."; fragment.append(empty); }
  $("schedules").replaceChildren(fragment);
  const active = document.createDocumentFragment();
  for (const watch of activeWatches) {
    const card = document.createElement("article"); card.className = "job";
    const title = document.createElement("strong"); title.textContent = `${watch.provider === "zoom" ? "Zoom" : "Teams"} · ${watch.title || "Конференция"}`;
    const status = document.createElement("p"); status.textContent = watch.status;
    const fresh = watch.lastReadAt && Date.now() - watch.lastReadAt <= 20000;
    const count = document.createElement("p"); count.textContent = watch.config.drop && watch.phase !== "joining" ? (fresh && Number.isInteger(watch.count) ? `Участников: ${watch.count}` : watch.source || "Ждём счётчик участников…") : "";
    card.append(title, status, count, action("Остановить автоматизацию", () => send({ type: "STOP", watchKey: watch.watchKey || "watch" })));
    active.append(card);
  }
  $("watches").replaceChildren(active); $("activeSection").hidden = !activeWatches.length;
}
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
  const result = await send({ type: "STATUS" });
  state = result.state; activeWatches = result.watches || []; schedules = result.schedules || [];
  const upcoming = schedules.filter(j => j.enabled && j.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
  $("status").textContent = activeWatches.length ? `Активных запусков: ${activeWatches.length}` : upcoming ? "Расписание включено" : state?.status || "Добавьте конференцию в расписание";
  $("details").textContent = upcoming ? `Ближайшая: ${upcoming.title} · ${formatDate(upcoming.nextAt)}` : "Настройте вход по ссылке или выход из открытой вкладки.";
  const stale = !state?.lastReadAt || Date.now() - state.lastReadAt > 20000;
  $("count").textContent = state?.active && state.config.drop ? (!stale && Number.isInteger(state.count) ? `Участников: ${state.count} · ${state.source}` : stale ? "Ждём актуальное число участников…" : state.source) : "";
  $("stop").disabled = !state?.active;
  const signature = JSON.stringify([schedules, activeWatches.map(({ samples, ...watch }) => watch)]);
  if (renderLists.signature !== signature) { renderLists(); renderLists.signature = signature; }
}
function populate(config) {
  for (const key of ["timed", "drop"]) $(key).checked = config[key];
  for (const key of ["percent", "minimum", "windowSeconds", "graceSeconds"]) $(key).value = config[key];
  const date = new Date(config.deadline || Date.now() + 3600000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  $("deadline").value = local.toISOString().slice(0, 16);
}
function syncMode() {
  const scheduled = $("mode").value === "schedule";
  $("scheduleFields").hidden = !scheduled; $("tabFields").hidden = scheduled; $("repeatHint").hidden = !scheduled;
  for (const id of ["url", "joinAt", "repeat"]) { $(id).required = scheduled; $(id).disabled = !scheduled; }
  $("tab").required = !scheduled;
  $("start").textContent = scheduled ? "Добавить в расписание" : "Включить автозакрытие";
  syncProvider();
}
function syncProvider() {
  const zoom = $("mode").value === "schedule" && $("provider").value === "zoom";
  $("zoomSetup").hidden = !zoom;
  $("zoomPrepared").required = zoom; $("zoomPrepared").disabled = !zoom;
  $("urlLabel").textContent = zoom ? "Постоянная ссылка Zoom" : "Постоянная ссылка Teams";
  $("url").placeholder = zoom ? "https://…zoom.us/j/12345678901?pwd=…" : "https://teams.microsoft.com/…";
  $("joinHint").textContent = zoom ? "Используйте ссылку приглашения с /j/ и ID конференции. Одновременно поддерживается одна конференция Zoom. Авторизация и допуск организатора могут потребовать участия." : "Вход с выключенными камерой и микрофоном. Войдите в аккаунт Teams и настройте доступы заранее. Зал ожидания требует допуска организатора.";
}
$("provider").onchange = syncProvider;
$("zoomPing").onclick = () => run(async () => {
  $("zoomStatus").textContent = "Проверяем…";
  try { const { helper } = await send({ type: "ZOOM_PING" }); $("zoomStatus").textContent = helper.zoomInstalled ? `Помощник ${helper.version} подключён. Zoom найден.` : "Помощник подключён. Установите Zoom Workplace для Windows."; }
  catch (error) { $("zoomStatus").textContent = error.message; throw error; }
});
$("mode").onchange = () => { syncMode(); if ($("mode").value === "manual") refreshTabs().catch(e => { $("error").textContent = e.message; }); };
async function run(fn) {
  if (busy) return; busy = true; $("error").textContent = ""; $("start").disabled = true;
  try { await fn(); await status(); } catch (e) { $("error").textContent = e.message; }
  finally { busy = false; $("start").disabled = false; }
}
$("form").onsubmit = event => { event.preventDefault(); run(async () => {
  const config = { timed: $("timed").checked, drop: $("drop").checked, deadline: new Date($("deadline").value).getTime(), selector: "" };
  for (const key of ["percent", "minimum", "windowSeconds", "graceSeconds"]) config[key] = Number($(key).value);
  if ($("mode").value === "schedule") {
    await send({ type: "SCHEDULE_ADD", schedule: { provider: $("provider").value, zoomPrepared: $("zoomPrepared").checked, title: $("title").value, url: $("url").value, joinAt: new Date($("joinAt").value).getTime(), repeat: $("repeat").value, guestName: $("guestName").value, config } });
  } else {
    const tabId = Number($("tab").value);
    if (!tabId) throw Error("Откройте вкладку Teams.");
    await chrome.scripting.executeScript({ target: { tabId }, files: ["reader.js", "joiner.js", "content.js"] });
    await send({ type: "START", tabId, config });
  }
  await chrome.storage.local.set({ preferences: { ...config, deadline: null } });
}); };
$("stop").onclick = () => run(() => send({ type: "STOP" }));
$("refresh").onclick = () => run(refreshTabs);
try {
  await status();
  populate(state?.active ? state.config : { ...DEFAULTS, ...(await chrome.storage.local.get("preferences")).preferences });
  const joinDate = new Date(Date.now() + 10 * 60000);
  $("joinAt").value = new Date(joinDate.getTime() - joinDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  syncMode();
  await refreshTabs();
} catch (e) { $("error").textContent = e.message; }
setInterval(() => { if (!busy) status().catch(e => { $("error").textContent = e.message; }); }, 2000);
