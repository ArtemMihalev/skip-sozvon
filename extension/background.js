import { isTeams, validate, observe } from "./rules.js";
import { closeTabWithConfirmation } from "./close-tab.js";
import { createScheduler, JOIN_PREFIX, SCHEDULE_CHECK } from "./schedule.js";

const KEY = "watch";
const ALARM = "sozvon-check";
let queue = Promise.resolve();
const serial = fn => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
const get = async (key = KEY) => (await chrome.storage.session.get(key))[key] ?? null;
const save = state => chrome.storage.session.set({ [state.watchKey || KEY]: state });
const watches = async () => Object.entries(await chrome.storage.session.get(null)).filter(([key, value]) => (key === KEY || key.startsWith("watch:")) && value?.active).map(([, value]) => value);
const deadlineAlarm = state => state.watchKey && state.watchKey !== KEY ? `sozvon-deadline:${state.watchKey}` : "sozvon-deadline";
const tell = (id, message) => chrome.tabs.sendMessage(id, message).catch(() => null);

async function finish(state, status) {
  await save({ ...state, active: false, status, candidate: null, samples: [] });
  if (!(await watches()).length) await chrome.alarms.clear(ALARM);
  await chrome.alarms.clear(deadlineAlarm(state));
  await tell(state.tabId, { type: "HIDE" });
  if (state.scheduleId) await scheduler.updateStatus(state.scheduleId, status);
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
    if (state.scheduleId) await scheduler.updateStatus(state.scheduleId, `Вкладка закрыта: ${reason}`);
  } catch (error) {
    const status = `Не удалось подтвердить закрытие: ${error.message} Закройте DevTools, проверьте разрешение «Отладка» и включите наблюдение повторно.`;
    await save({ ...state, active: false, candidate: null, samples: [], status });
    if (state.scheduleId) await scheduler.updateStatus(state.scheduleId, status);
  }
}

async function tickWatch(state) {
  if (!state?.active) return;
  const now = Date.now();
  if (state.phase === "joining") {
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab) return finish(state, "Вкладка входа закрыта");
    if (!isTeams(tab.url)) {
      if (now - state.joinStartedAt >= 15 * 60000 || (state.config.timed && now >= state.config.deadline)) return finish(state, "Вход не завершён: требуется авторизация Teams.");
      return save({ ...state, status: "Ожидаем авторизацию и возврат в Teams. Войдите в аккаунт вручную." });
    }
    state = { ...state, url: tab.url, title: tab.title || state.title };
    await save(state);
    if (state.config.timed && now >= state.config.deadline) return close(state, "наступило время выхода, вход ещё не завершён");
    if (now - state.joinStartedAt >= 15 * 60000) return finish(state, "Не удалось подтвердить вход за 15 минут. Проверьте вкладку Teams.");
    const joined = await tell(state.tabId, { type: "AUTO_JOIN", url: state.url, guestName: state.guestName });
    if (joined?.url !== state.url) return;
    state.status = joined.status;
    if (joined.phase !== "joined") return save(state);
    state.phase = "watching";
    state.samples = []; state.candidate = null;
    await save(state);
    await scheduler.updateStatus(state.scheduleId, "Подключено. Следим за условиями выхода.");
  }
  if (!await target(state)) return;
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

async function tick(key) {
  const states = key ? [await get(key)] : await watches();
  for (const state of states) await tickWatch(state);
}

async function arm(state) {
  await save(state);
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  if (state.config.timed) await chrome.alarms.create(deadlineAlarm(state), { when: state.config.deadline });
}

const scheduler = createScheduler(chrome, async (job, config) => {
  const tab = await chrome.tabs.create({ url: job.url, active: true });
  await arm({ watchKey: `watch:${job.id}`, scheduleId: job.id, active: true, tabId: tab.id, url: job.url,
    title: job.title, config, phase: "joining", guestName: job.guestName, joinStartedAt: Date.now(),
    samples: [], candidate: null, count: null, status: "Открываем Teams и подключаемся…" });
}, async id => (await watches()).some(state => state.scheduleId === id));

async function handle(message, sender) {
  const state = sender.tab ? (await watches()).find(w => w.tabId === sender.tab.id) : await get(message.watchKey || KEY);
  // Page scripts may only request a tick or cancel their own monitoring.
  if (sender.tab && (sender.tab.id !== state?.tabId || !["TICK", "STOP"].includes(message.type))) return { ok: false };
  if (message.type === "STATUS") return { ok: true, state, watches: await watches(), schedules: await scheduler.list() };
  if (message.type === "SCHEDULE_ADD") { const job = await scheduler.add(message.schedule); return { ok: true, job }; }
  if (message.type === "SCHEDULE_TOGGLE") { await scheduler.toggle(message.id); return { ok: true }; }
  if (message.type === "SCHEDULE_REMOVE") {
    const active = await get(`watch:${message.id}`);
    if (active?.active) await finish(active, "Задание удалено. Автоматизация этой вкладки остановлена.");
    await scheduler.remove(message.id); return { ok: true };
  }
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
    const duplicate = (await watches()).find(w => w.tabId === tab.id && w.watchKey !== KEY);
    if (duplicate) throw Error("Эта вкладка уже управляется расписанием. Сначала остановите её автоматизацию.");
    if (state?.active) await finish(state, "Заменено новым правилом");
    await arm({ watchKey: KEY, active: true, tabId: tab.id, url: tab.url, title: tab.title, config, samples: [], candidate: null, count: null, status: "Наблюдение включено" });
    await tick(KEY);
    return { ok: true };
  }
  if (message.type === "TICK") { await tick(sender.tab ? state.watchKey || KEY : undefined); return { ok: true }; }
  throw Error("Неизвестная команда");
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SCHEDULE_CHECK || alarm.name.startsWith(JOIN_PREFIX)) serial(() => scheduler.due()).catch(console.error);
  if (alarm.name === ALARM || alarm.name.startsWith("sozvon-deadline")) serial(() => tick()).catch(console.error);
});
chrome.tabs.onRemoved.addListener(id => serial(async () => {
  for (const state of await watches()) if (state.tabId === id) await finish(state, "Вкладка закрыта");
}).catch(console.error));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) serial(async () => {
    for (const state of await watches()) if (id === state.tabId && change.url !== state.url && state.phase !== "joining") await finish(state, "Адрес вкладки изменился. Включите наблюдение повторно.");
  }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => serial(() => scheduler.restore()).catch(console.error));
chrome.runtime.onInstalled.addListener(() => serial(() => scheduler.restore()).catch(console.error));

// Restore alarms after a service worker restart; session storage is cleared on browser restart.
serial(async () => {
  const states = await watches();
  if (states.length) {
    for (const state of states) await arm(state);
    await tick();
  } else {
    await chrome.alarms.clear(ALARM);
    await chrome.alarms.clear("sozvon-deadline");
  }
  await scheduler.restore();
}).catch(console.error);
