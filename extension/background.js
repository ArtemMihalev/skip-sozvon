import { isTeams, validate, observe } from "./rules.js";
import { closeTabWithConfirmation } from "./close-tab.js";

const KEY = "watch";
const ALARM = "sozvon-check";
let queue = Promise.resolve();
const serial = fn => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
const get = async () => (await chrome.storage.session.get(KEY))[KEY] ?? null;
const save = state => chrome.storage.session.set({ [KEY]: state });
const tell = (id, message) => chrome.tabs.sendMessage(id, message).catch(() => null);

async function finish(state, status) {
  await save({ ...state, active: false, status, candidate: null, samples: [] });
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.clear("sozvon-deadline");
  await tell(state.tabId, { type: "HIDE" });
}

async function target(state) {
  const tab = await chrome.tabs.get(state.tabId).catch(() => null);
  if (!tab || !isTeams(tab.url) || tab.url !== state.url || (tab.pendingUrl && tab.pendingUrl !== state.url)) {
    await finish(state, "Наблюдение остановлено: вкладка закрыта или адрес изменился.");
    return null;
  }
  return tab;
}

async function close(state, reason) {
  if (!await target(state)) return;
  // Disarm before removal: a stale queued tick cannot close another tab.
  await finish(state, `Закрываем вкладку: ${reason}`);
  try {
    await closeTabWithConfirmation(chrome, state.tabId, state.url);
    await save({ ...state, active: false, candidate: null, samples: [], status: `Вкладка закрыта: ${reason}` });
  } catch (error) {
    await save({ ...state, active: false, candidate: null, samples: [], status: `Не удалось подтвердить закрытие: ${error.message} Закройте DevTools, проверьте разрешение «Отладка» и включите наблюдение повторно.` });
  }
}

async function tick() {
  let state = await get();
  if (!state?.active || !await target(state)) return;
  const now = Date.now();
  if (state.config.timed && now >= state.config.deadline) return close(state, "наступило заданное время");
  if (!state.config.drop) return;
  const reading = await tell(state.tabId, { type: "READ", selector: state.config.selector });
  const valid = reading?.url === state.url;
  const count = valid ? reading.count : null;
  const result = observe(state, count, now);
  const hadCandidate = !!state.candidate;
  state = { ...state, ...result, count, lastReadAt: now, source: reading?.source ?? "Нет связи с вкладкой. Обновите страницу Teams.", status: result.candidate ? "Отток обнаружен, идёт подтверждение…" : "Наблюдение включено" };
  delete state.hit;
  await save(state);
  if (result.hit) return close(state, "участники покидают конференцию");
  if (result.candidate && !hadCandidate) await tell(state.tabId, { type: "WARN", at: result.candidate.at + state.config.graceSeconds * 1000 });
  else if (!result.candidate && hadCandidate) await tell(state.tabId, { type: "HIDE" });
}

async function handle(message, sender) {
  const state = await get();
  // Page scripts may only request a tick or cancel their own monitoring.
  if (sender.tab && (sender.tab.id !== state?.tabId || !["TICK", "STOP"].includes(message.type))) return { ok: false };
  if (message.type === "STATUS") return { ok: true, state };
  if (message.type === "STOP") {
    if (state?.active) await finish(state, "Автозакрытие отменено");
    return { ok: true };
  }
  if (message.type === "START") {
    const config = validate(message.config);
    const tab = await chrome.tabs.get(message.tabId);
    if (!isTeams(tab.url) || tab.pendingUrl) throw Error("Выберите загруженную вкладку Teams.");
    if (config.selector) {
      const probe = await tell(tab.id, { type: "READ", selector: config.selector });
      if (!probe || probe.count === null) throw Error(probe?.source || "Обновите страницу Teams и попробуйте снова.");
    }
    if (state?.active) await finish(state, "Заменено новым правилом");
    await save({ active: true, tabId: tab.id, url: tab.url, title: tab.title, config, samples: [], candidate: null, count: null, status: "Наблюдение включено" });
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (config.timed) await chrome.alarms.create("sozvon-deadline", { when: config.deadline });
    await tick();
    return { ok: true };
  }
  if (message.type === "TICK") { await tick(); return { ok: true }; }
  throw Error("Неизвестная команда");
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if ([ALARM, "sozvon-deadline"].includes(alarm.name)) serial(tick).catch(console.error);
});
chrome.tabs.onRemoved.addListener(id => serial(async () => {
  const state = await get();
  if (state?.active && state.tabId === id) await finish(state, "Вкладка закрыта");
}).catch(console.error));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) serial(async () => {
    const state = await get();
    if (state?.active && id === state.tabId && change.url !== state.url) await finish(state, "Адрес вкладки изменился. Включите наблюдение повторно.");
  }).catch(console.error);
});

// Restore alarms after a service worker restart; session storage is cleared on browser restart.
serial(async () => {
  const state = await get();
  if (state?.active) {
    if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (state.config.timed && !await chrome.alarms.get("sozvon-deadline")) await chrome.alarms.create("sozvon-deadline", { when: state.config.deadline });
    await tick();
  } else {
    await chrome.alarms.clear(ALARM);
    await chrome.alarms.clear("sozvon-deadline");
  }
}).catch(console.error);
