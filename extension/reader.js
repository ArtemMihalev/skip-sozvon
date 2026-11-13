(() => {
  if (globalThis.SozvonReader) return;
  const parse = text => {
    const s = String(text ?? "").replace(/\s+/g, " ").trim();
    const matches = [...s.matchAll(/\d+/g)];
    if (matches.length !== 1) return null;
    const n = Number(matches[0][0]);
    return n >= 1 && n <= 100000 ? n : null;
  };
  function read(doc, selector = "") {
    if (selector) {
      try {
        const nodes = doc.querySelectorAll(selector);
        if (nodes.length !== 1) return { count: null, source: "Селектор должен находить ровно один счётчик." };
        return { count: parse(nodes[0].textContent), source: "Ваш счётчик" };
      } catch { return { count: null, source: "Ошибка CSS-селектора." }; }
    }
    // Use only explicit counters. Never count tiles or roster rows (virtualized / invited).
    const nodes = doc.querySelectorAll('[data-tid="participant-count"], [data-tid="participants-count"], [data-tid="roster-button"], #roster-button, [role="heading"], h2, h3');
    const values = [];
    for (const el of nodes) {
      if (!el.getClientRects().length) continue;
      const explicit = /^(participant-count|participants-count|roster-button)$/.test(el.getAttribute("data-tid") || "") || el.id === "roster-button";
      const texts = [el.getAttribute("aria-label"), el.textContent].filter(Boolean);
      for (const text of texts) {
        if (text.length > 120 || /invited|not in|lobby|приглаш|не присоедин|ожидан/i.test(text)) continue;
        if (!explicit && !/^(?:in (?:this |the )?meeting|в (?:этом )?(?:собрании|звонке|конференции))\s*[:(]?\s*\d+\s*\)?$/i.test(text.trim())) continue;
        const count = parse(text);
        if (count !== null) values.push(count);
      }
    }
    const unique = [...new Set(values)];
    return unique.length === 1 ? { count: unique[0], source: "Счётчик Teams" } : { count: null, source: unique.length ? "Счётчики расходятся. Проверьте панель участников." : "Счётчик не найден. Откройте панель «Участники»." };
  }
  globalThis.SozvonReader = { parse, read };
})();
