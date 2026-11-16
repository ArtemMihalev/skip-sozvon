export const ZOOM_HOST = "com.sozvon.zoom";

export function parseZoomLink(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("Укажите ссылку Zoom вида https://…zoom.us/j/12345678901?pwd=…"); }
  const allowed = ["zoom.us", "zoom.com"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain));
  const match = url.pathname.match(/^\/j\/(\d{9,11})\/?$/);
  if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port || !match) throw Error("Нужна полная HTTPS-ссылка Zoom с /j/ и числовым ID конференции. Ссылки /my/ сначала замените ссылкой приглашения.");
  if (url.href.length > 4096 || (url.searchParams.get("pwd") || "").length > 1024) throw Error("Слишком длинная ссылка Zoom.");
  return { url: url.href, meetingId: match[1] };
}

export class ZoomBridge {
  constructor(api, onStatus, onDisconnect) {
    this.api = api; this.onStatus = onStatus; this.onDisconnect = onDisconnect;
    this.port = null; this.pending = new Map();
  }
  connect() {
    if (this.port) return;
    const port = this.api.runtime.connectNative(ZOOM_HOST);
    this.port = port;
    port.onMessage.addListener(message => {
      if (message.type === "status") this.onStatus(message.state);
      if (message.type === "reply") {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.requestId);
        if (message.ok) request.resolve(message);
        else request.reject(Error(message.error || "Ошибка помощника Zoom"));
      }
    });
    port.onDisconnect.addListener(() => {
      const detail = this.api.runtime.lastError?.message;
      const error = Error(`Помощник Zoom недоступен. Установите его или проверьте подключение.${detail ? " " + detail : ""}`);
      if (this.port === port) this.port = null;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.onDisconnect(error.message);
    });
  }
  request(command, data = {}) {
    this.connect();
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error("Помощник Zoom не ответил за 20 секунд. Проверьте приложение перед повторным запуском.")); }, 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.port.postMessage({ ...data, command, requestId }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
}
