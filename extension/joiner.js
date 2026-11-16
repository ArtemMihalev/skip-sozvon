(() => {
  if (globalThis.SozvonJoiner) return;
  const contexts = new WeakMap();
  const text = el => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
  const visible = el => el.getClientRects().length && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const find = (root, selector) => [...root.querySelectorAll(selector)].find(visible);
  const button = (root, pattern) => [...root.querySelectorAll('button, a, [role="button"]')].find(el => visible(el) && pattern.test(text(el)));
  function toggleOff(root, selector, kind) {
    const el = find(root, selector);
    if (!el) return false;
    const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed");
    const label = text(el);
    const turnOff = kind === "camera" ? /^(?:turn (?:the )?camera off|turn off (?:the )?camera|выключить камеру|отключить камеру)$/i : /^(?:mute(?: (?:the )?microphone)?|turn (?:the )?microphone off|выключить микрофон|отключить микрофон)$/i;
    const turnOn = kind === "camera" ? /^(?:turn (?:the )?camera on|turn on (?:the )?camera|включить камеру)$/i : /^(?:unmute(?: (?:the )?microphone)?|turn (?:the )?microphone on|включить микрофон)$/i;
    if (turnOff.test(label) || (checked === "true" && !turnOn.test(label))) { el.click(); return false; }
    return turnOn.test(label) || checked === "false";
  }
  function step(doc, options = {}, now = Date.now()) {
    let context = contexts.get(doc);
    if (!context) { context = { clickedAt: null, rosterOpened: false }; contexts.set(doc, context); }
    const body = doc.body?.innerText || "";
    const roster = find(doc, '[data-tid="roster-button"], #roster-button');
    const hangup = find(doc, '[data-tid="hangup-button"], #hangup-button');
    if (roster && hangup) {
      if (roster.getAttribute("aria-expanded") === "false" || (!context.rosterOpened && roster.getAttribute("aria-expanded") !== "true" && !find(doc, '[data-tid="roster-pane"], [data-tid="roster-list"]'))) {
        roster.click(); context.rosterOpened = true;
      }
      return { phase: "joined", status: "Подключено. Следим за условиями выхода." };
    }
    if (/someone.*let you in|waiting.*(?:lobby|admit)|кто-то.*(?:впустит|допустит)|ожида(?:йте|ние).*?(?:допуска|организатор)|вас скоро впустят|когда собрание начнется/i.test(body)) return { phase: "lobby", status: "В зале ожидания. Нужен допуск организатора." };
    if (find(doc, 'input[type="password"], input[type="email"]')) return { phase: "attention", status: "Teams требует входа в аккаунт. Выполните его вручную." };
    const web = button(doc, /^(?:continue (?:on|in) this browser|join on the web instead|continue on this browser instead|продолжить (?:в этом |в )браузере|присоединиться в браузере|присоединиться через браузер)$/i);
    if (web) {
      if (context.clickedAt === null || now - context.clickedAt >= 10000) { web.click(); context.clickedAt = now; }
      return { phase: "joining", status: "Открываем веб-версию Teams…" };
    }
    // A guest's Join button can be disabled until their name has been filled.
    const join = [...doc.querySelectorAll('[data-tid="prejoin-join-button"], #prejoin-join-button')].find(el => el.getClientRects().length);
    const prejoin = find(doc, '[data-tid="prejoin-screen"], [data-tid="prejoin-ui"], [data-tid="prejoin-pre-call"]');
    const joinButton = join || (prejoin && button(prejoin, /^(?:join now|join meeting|присоединиться(?: сейчас)?|войти сейчас)$/i));
    if (joinButton) {
      const name = find(doc, 'input[data-tid="prejoin-display-name-input"], #username, input[placeholder="Type your name"], input[placeholder="Введите имя"]');
      if (name && !name.value.trim()) {
        if (!options.guestName) return { phase: "attention", status: "Для гостевого входа укажите имя в задании или войдите в аккаунт Teams." };
        const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, "value").set;
        setter.call(name, options.guestName);
        name.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
        name.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      }
      const cameraOff = toggleOff(doc, '[data-tid="toggle-video"], [data-tid="prejoin-camera-toggle"], #video-button, [role="switch"][aria-label*="камера"], [role="switch"][aria-label*="Camera"]', "camera");
      const micOff = toggleOff(doc, '[data-tid="toggle-mute"], [data-tid="prejoin-mic-toggle"], #microphone-button, [role="switch"][aria-label*="микрофон"], [role="switch"][aria-label*="Microphone"]', "microphone");
      if (!cameraOff || !micOff) return { phase: "attention", status: "Подготовка входа: выключаем камеру и микрофон. Если статус не меняется, проверьте экран Teams." };
      if (!visible(joinButton)) return { phase: "joining", status: "Ожидаем готовность кнопки подключения…" };
      if (context.clickedAt === null || now - context.clickedAt >= 10000) { joinButton.click(); context.clickedAt = now; }
      return { phase: "joining", status: "Нажали «Присоединиться». Ожидаем подтверждение входа…" };
    }
    return { phase: "joining", status: "Ожидаем загрузку Teams. Если открылись запросы доступа, подтвердите их один раз вручную." };
  }
  globalThis.SozvonJoiner = { step };
})();
