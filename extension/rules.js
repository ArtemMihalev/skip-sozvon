export const DEFAULTS = { timed: false, deadline: null, drop: true, percent: 30, minimum: 3, windowSeconds: 120, graceSeconds: 30, selector: "" };

export function isTeams(url) {
  try { const u = new URL(url); return u.protocol === "https:" && ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(u.hostname); }
  catch { return false; }
}

export function validate(input, now = Date.now()) {
  const c = { ...DEFAULTS, ...input };
  if (typeof c.timed !== "boolean" || typeof c.drop !== "boolean" || (!c.timed && !c.drop)) throw Error("Включите хотя бы одно условие.");
  if (c.timed && (!Number.isFinite(c.deadline) || c.deadline <= now)) throw Error("Укажите дату и время в будущем.");
  for (const [key, min, max] of [["percent", 1, 100], ["minimum", 1, 10000], ["windowSeconds", 1, 3600], ["graceSeconds", 1, 300]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw Error(`Недопустимое значение: ${key} (${min}–${max}).`);
  }
  if (typeof c.selector !== "string" || c.selector.length > 500) throw Error("Слишком длинный CSS-селектор.");
  return c;
}

export function observe(state, count, now) {
  // Missing data breaks continuity; it must never look like zero attendees.
  if (!Number.isInteger(count) || count < 1 || count > 100000) return { samples: [], candidate: null, hit: false };
  const windowMs = state.config.windowSeconds * 1000;
  const previous = state.samples ?? [];
  const continuous = previous.length && now - previous.at(-1).at <= 20000;
  const samples = (continuous ? previous : []).filter(s => s.at >= now - windowMs && s.at <= now);
  samples.push({ at: now, count });
  const peak = Math.max(...samples.map(s => s.count));
  const lost = peak - count;
  const qualifies = lost >= state.config.minimum && lost * 100 >= peak * state.config.percent;
  // Preserve the reference during the confirmation period, even as the window moves.
  let candidate = continuous ? state.candidate : null;
  if (candidate && (candidate.peak - count < state.config.minimum || (candidate.peak - count) * 100 < candidate.peak * state.config.percent)) candidate = null;
  if (!candidate && qualifies) candidate = { at: now, peak };
  const hit = !!candidate && now - candidate.at >= state.config.graceSeconds * 1000;
  return { samples, candidate, hit };
}
