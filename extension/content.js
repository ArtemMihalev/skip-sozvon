(() => {
  if (globalThis.sozvonContentLoaded) return;
  globalThis.sozvonContentLoaded = true;
  let banner;
  function hide() { banner?.remove(); banner = null; }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === "AUTO_JOIN") {
      if (location.href !== message.url) reply({ phase: "joining", status: "Страница меняется…", url: location.href });
      else reply({ ...globalThis.SozvonJoiner.step(document, { guestName: message.guestName }), url: location.href });
    }
    if (message.type === "READ") reply({ ...globalThis.SozvonReader.read(document, message.selector), url: location.href });
    if (message.type === "HIDE") { hide(); reply({ ok: true }); }
    if (message.type === "WARN") {
      hide();
      banner = document.createElement("div");
      const root = banner.attachShadow({ mode: "closed" });
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;top:18px;right:18px;z-index:2147483647;max-width:360px;padding:20px;background:#172b29;color:white;border:2px solid #70e1bc;border-radius:16px;font:15px/1.5 system-ui;box-shadow:0 8px 40px #0008";
      const text = document.createElement("div");
      text.textContent = `Участники уходят. Вкладка будет закрыта после ${new Date(message.at).toLocaleTimeString()} при сохранении оттока.`;
      const button = document.createElement("button");
      button.textContent = "Отменить автозакрытие";
      button.style.cssText = "margin-top:12px;padding:10px;border:0;border-radius:8px;cursor:pointer";
      button.onclick = () => chrome.runtime.sendMessage({ type: "STOP" }).then(hide).catch(() => {});
      box.append(text, button); root.append(box); document.documentElement.append(banner);
      reply({ ok: true });
    }
  });
  // Polling is best effort in background tabs; stale observations reset the rule.
  setInterval(() => chrome.runtime.sendMessage({ type: "TICK" }).catch(() => {}), 5000);
})();
