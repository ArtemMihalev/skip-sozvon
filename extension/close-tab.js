// Browser-owned beforeunload dialogs cannot be clicked by a content script.
// Attach only for this close operation, accept only beforeunload, and wait for
// onRemoved rather than assuming that a successful protocol command closed it.
export async function closeTabWithConfirmation(api, tabId, expectedUrl, timeoutMs = 12000) {
  const debuggee = { tabId };
  let attached = false;
  let closing = false;
  let timer;
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const onRemoved = id => { if (id === tabId && closing) resolveClosed(); };
  const onDetached = (source, reason) => {
    if (source.tabId === tabId && closing && reason !== "target_closed") rejectClosed(Error("Chrome отключил отладку до завершения закрытия."));
  };
  const onEvent = (source, method, params) => {
    if (!closing || source.tabId !== tabId || method !== "Page.javascriptDialogOpening" || params.type !== "beforeunload") return;
    api.debugger.sendCommand(debuggee, "Page.handleJavaScriptDialog", { accept: true }).catch(rejectClosed);
  };
  try {
    await api.debugger.attach(debuggee, "1.3");
    attached = true;
    api.debugger.onEvent.addListener(onEvent);
    api.debugger.onDetach.addListener(onDetached);
    api.tabs.onRemoved.addListener(onRemoved);
    await api.debugger.sendCommand(debuggee, "Page.enable");
    const tab = await api.tabs.get(tabId);
    if (tab.url !== expectedUrl || (tab.pendingUrl && tab.pendingUrl !== expectedUrl)) throw Error("Адрес вкладки изменился перед закрытием.");
    closing = true;
    timer = setTimeout(() => rejectClosed(Error("Chrome не подтвердил закрытие вкладки за 12 секунд.")), timeoutMs);
    // Page.close runs the page's beforeunload handlers and emits dialog events.
    api.debugger.sendCommand(debuggee, "Page.close").catch(rejectClosed);
    await closed;
  } finally {
    closing = false;
    clearTimeout(timer);
    api.debugger.onEvent.removeListener(onEvent);
    api.debugger.onDetach.removeListener(onDetached);
    api.tabs.onRemoved.removeListener(onRemoved);
    if (attached) await api.debugger.detach(debuggee).catch(() => {});
  }
}
