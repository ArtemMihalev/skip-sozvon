import { isTeams, validate } from "./rules.js";
import { parseZoomLink } from "./zoom.js";

export const JOIN_PREFIX = "sozvon-join:";
export const SCHEDULE_CHECK = "sozvon-schedules";
export const LATE_LIMIT = 5 * 60 * 1000;

export function validateSchedule(input, now = Date.now()) {
  let url = String(input.url ?? "").trim();
  const provider = input.provider || "teams";
  if (!["teams", "zoom"].includes(provider)) throw Error("Выберите Teams или Zoom.");
  if (provider === "zoom") {
    url = parseZoomLink(url).url;
    if (input.zoomPrepared !== true) throw Error("Сначала настройте в Zoom вход с выключенными камерой и микрофоном и отметьте это в форме.");
  } else if (!isTeams(url) || new URL(url).username || new URL(url).password || new URL(url).pathname === "/") throw Error("Укажите полную ссылку на конференцию Teams.");
  if (!Number.isFinite(input.joinAt) || input.joinAt <= now) throw Error("Укажите дату и время входа в будущем.");
  if (!["once", "daily", "weekdays", "weekly"].includes(input.repeat)) throw Error("Выберите повторение.");
  if (input.repeat === "weekdays" && [0, 6].includes(new Date(input.joinAt).getDay())) throw Error("Для повтора по будням выберите первый вход с понедельника по пятницу.");
  const config = validate({ ...input.config, selector: "" }, now);
  if (config.timed && config.deadline <= input.joinAt) throw Error("Выход должен быть позже входа.");
  const guestName = String(input.guestName ?? "").trim();
  if (guestName.length > 100) throw Error("Имя должно быть не длиннее 100 символов.");
  return {
    id: crypto.randomUUID(), provider, zoomPrepared: provider === "zoom", title: String(input.title ?? "").trim().slice(0, 100) || (provider === "zoom" ? "Конференция Zoom" : "Конференция Teams"),
    url, guestName, joinAt: input.joinAt, nextAt: input.joinAt, repeat: input.repeat,
    config, exitOffset: config.timed ? config.deadline - input.joinAt : null,
    enabled: true, lastStatus: "Ожидает запуска", lastOccurrence: null
  };
}

export function nextOccurrence(at, repeat, now) {
  if (repeat === "once") return null;
  const date = new Date(at);
  do {
    date.setDate(date.getDate() + (repeat === "weekly" ? 7 : 1));
  } while (date.getTime() <= now || (repeat === "weekdays" && [0, 6].includes(date.getDay())));
  return date.getTime();
}

// All methods run inside the background's serial queue. Claim and advance the
// occurrence before creating a tab, so worker restarts cannot launch it twice.
export function createScheduler(api, launch, activeFor) {
  const list = async () => (await api.storage.local.get("schedules")).schedules ?? [];
  const write = jobs => api.storage.local.set({ schedules: jobs });
  async function alarms(jobs) {
    const expected = new Set();
    for (const job of jobs) if (job.enabled && job.nextAt) {
      const name = JOIN_PREFIX + job.id;
      expected.add(name);
      const existing = await api.alarms.get(name);
      if (!existing || existing.scheduledTime !== job.nextAt) await api.alarms.create(name, { when: job.nextAt });
    }
    for (const alarm of await api.alarms.getAll()) if (alarm.name.startsWith(JOIN_PREFIX) && !expected.has(alarm.name)) await api.alarms.clear(alarm.name);
    if (expected.size) {
      if (!await api.alarms.get(SCHEDULE_CHECK)) await api.alarms.create(SCHEDULE_CHECK, { periodInMinutes: 0.5 });
    } else await api.alarms.clear(SCHEDULE_CHECK);
  }
  async function updateStatus(id, status) {
    const jobs = await list();
    const job = jobs.find(j => j.id === id);
    if (job) { job.lastStatus = status; await write(jobs); }
  }
  async function due() {
    const jobs = await list();
    const now = Date.now();
    for (const job of jobs) {
      if (!job.enabled || !job.nextAt || job.nextAt > now) continue;
      const occurrence = job.nextAt;
      job.lastOccurrence = occurrence;
      job.nextAt = nextOccurrence(occurrence, job.repeat, now);
      job.enabled = job.nextAt !== null;
      job.lastStatus = "Запуск отмечен. Открываем вкладку…";
      await write(jobs);
      const deadline = job.config.timed ? occurrence + job.exitOffset : null;
      if (now - occurrence > LATE_LIMIT || (deadline !== null && deadline <= now)) job.lastStatus = "Вход пропущен: Chrome не работал вовремя или компьютер спал (допуск 5 минут).";
      else if (await activeFor(job.id)) job.lastStatus = "Вход пропущен: предыдущий запуск этой конференции ещё активен.";
      else {
        try {
          await launch(job, { ...job.config, deadline });
          job.lastStatus = job.provider === "zoom" ? "Zoom запущен. Подключаемся…" : "Вкладка открыта. Подключаемся…";
        } catch (error) { job.lastStatus = `Не удалось открыть конференцию: ${error.message}`; }
      }
      await write(jobs);
    }
    await alarms(jobs);
  }
  return {
    list, due, updateStatus,
    restore: async () => { await alarms(await list()); await due(); },
    add: async input => {
      const job = validateSchedule(input);
      const jobs = await list();
      if (jobs.length >= 100) throw Error("Можно сохранить до 100 конференций. Удалите старые задания.");
      if (jobs.some(existing => existing.enabled && existing.url === job.url && existing.nextAt === job.nextAt)) throw Error("Эта ссылка уже запланирована на указанное время.");
      jobs.push(job); await write(jobs); await alarms(jobs); return job;
    },
    remove: async id => { const jobs = (await list()).filter(j => j.id !== id); await write(jobs); await alarms(jobs); },
    toggle: async id => {
      const jobs = await list(); const job = jobs.find(j => j.id === id);
      if (!job) throw Error("Задание не найдено.");
      if (!job.enabled && job.repeat === "once" && job.joinAt <= Date.now()) throw Error("Разовое время уже прошло. Создайте новое задание.");
      job.enabled = !job.enabled;
      if (job.enabled && (!job.nextAt || job.nextAt <= Date.now())) job.nextAt = nextOccurrence(job.joinAt, job.repeat, Date.now());
      await write(jobs); await alarms(jobs);
    }
  };
}
