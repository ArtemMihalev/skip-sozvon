using System;
using System.Collections.Generic;
using System.Linq;

namespace Sozvon {
  public sealed class ExitConfig {
    public bool Timed, Drop;
    public long Deadline;
    public int Percent, Minimum, WindowSeconds, GraceSeconds;
    public static ExitConfig Parse(Dictionary<string, object> values) {
      if (values == null) throw new ArgumentException("Не заданы условия выхода.");
      var c = new ExitConfig { Timed = Json.Bool(values, "timed"), Drop = Json.Bool(values, "drop"), Percent = Range(values, "percent", 1, 100), Minimum = Range(values, "minimum", 1, 10000), WindowSeconds = Range(values, "windowSeconds", 1, 3600), GraceSeconds = Range(values, "graceSeconds", 1, 300) };
      if (!c.Timed && !c.Drop) throw new ArgumentException("Включите хотя бы одно условие выхода.");
      if (c.Timed) c.Deadline = Json.Number(values, "deadline");
      return c;
    }
    private static int Range(Dictionary<string, object> d, string key, int min, int max) {
      long n = Json.Number(d, key); if (n < min || n > max) throw new ArgumentException("Недопустимый порог: " + key); return (int)n;
    }
  }
  public sealed class Sample { public long At; public int Count; }
  public sealed class DropRule {
    private readonly ExitConfig config;
    private List<Sample> samples = new List<Sample>();
    public long CandidateAt; public int Peak;
    public DropRule(ExitConfig c) { config = c; }
    public bool Observe(int? count, long now) {
      if (!count.HasValue || count < 1 || count > 100000 || (samples.Count > 0 && now - samples.Last().At > 20000)) { samples.Clear(); CandidateAt = 0; Peak = 0; }
      if (!count.HasValue || count < 1 || count > 100000) return false;
      samples = samples.Where(s => s.At >= now - config.WindowSeconds * 1000L && s.At <= now).ToList();
      samples.Add(new Sample { At = now, Count = count.Value });
      int currentPeak = samples.Max(s => s.Count);
      if (CandidateAt != 0 && !Qualifies(Peak, count.Value)) { CandidateAt = 0; Peak = 0; }
      if (CandidateAt == 0 && Qualifies(currentPeak, count.Value)) { CandidateAt = now; Peak = currentPeak; }
      return CandidateAt != 0 && now - CandidateAt >= config.GraceSeconds * 1000L;
    }
    private bool Qualifies(int peak, int count) { int lost = peak - count; return lost >= config.Minimum && lost * 100L >= peak * (long)config.Percent; }
  }
  public sealed class ZoomObservation {
    public bool Joined, Ended, LeaveConfirmed;
    public int? Count;
    public string Status;
  }
  public interface IZoomAutomation {
    bool Installed { get; }
    void Start(ZoomLink link, string guestName);
    ZoomObservation Observe(bool leaving, string guestName);
    void RequestLeave();
    void Reset();
  }
  public sealed class Controller {
    private readonly IZoomAutomation automation;
    private ExitConfig config;
    private DropRule rule;
    private string runId = "", name = "", phase = "idle", status = "Zoom: нет активного запуска", exitReason;
    private bool active;
    private long startedAt, leaveAt;
    private int? count;
    public Controller(IZoomAutomation adapter) { automation = adapter; }
    public Dictionary<string, object> State(long now) { return Json.Obj("runId", runId, "active", active, "phase", phase, "status", status, "count", count, "at", now, "candidateAt", rule == null ? 0 : rule.CandidateAt); }
    public Dictionary<string, object> Handle(Dictionary<string, object> message, long now) {
      string command = Json.Text(message, "command");
      if (command == "PING") return Json.Obj("version", "0.4.0", "zoomInstalled", automation.Installed);
      if (command == "STATUS") return Json.Obj("state", State(now));
      if (command == "START") {
        if (active) throw new InvalidOperationException("Другая конференция Zoom уже управляется помощником.");
        Guid parsed;
        if (!Guid.TryParse(Json.Text(message, "runId"), out parsed)) throw new ArgumentException("Invalid run ID");
        if (!Json.Bool(message, "zoomPrepared")) throw new ArgumentException("Настройте выключение камеры и микрофона при входе в Zoom.");
        var link = ZoomLink.Parse(Json.Text(message, "url"));
        var nextConfig = ExitConfig.Parse(Json.Get(message, "config") as Dictionary<string, object>);
        if (nextConfig.Timed && nextConfig.Deadline <= now) throw new ArgumentException("Время выхода уже прошло.");
        string guest = Json.Text(message, "guestName"); if (guest.Length > 100) throw new ArgumentException("Слишком длинное имя.");
        automation.Start(link, guest);
        config = nextConfig; rule = new DropRule(config); runId = parsed.ToString(); name = guest;
        active = true; startedAt = now; count = null; phase = "joining"; status = "Zoom запущен. Ожидаем подключение…";
        return Json.Obj("state", State(now));
      }
      if (command == "STOP" || command == "LEAVE") {
        if (!active || Json.Text(message, "runId") != runId) throw new InvalidOperationException("Запуск Zoom уже завершён или изменился.");
        if (command == "STOP") End("Автоматизация Zoom остановлена. Конференция остаётся открытой.");
        else BeginLeave(now, "запрос выхода");
        return Json.Obj("state", State(now));
      }
      throw new ArgumentException("Неизвестная команда помощника.");
    }
    public void Tick(long now) {
      if (!active) return;
      try {
        if (phase != "leaving" && config.Timed && now >= config.Deadline) BeginLeave(now, "наступило время выхода");
        var observed = automation.Observe(phase == "leaving", name);
        count = observed.Count;
        if (phase == "leaving") {
          if (observed.LeaveConfirmed || observed.Ended) { End("Выход из Zoom подтверждён: " + exitReason); return; }
          if (now - leaveAt >= 30000) { End("Не удалось подтвердить выход из Zoom за 30 секунд. Проверьте конференцию вручную."); return; }
          status = observed.Status ?? "Выходим из Zoom…"; return;
        }
        if (observed.Ended) { End("Конференция Zoom закрыта"); return; }
        if (observed.Joined) {
          phase = "watching";
          status = observed.Status ?? "Подключено к Zoom. Следим за условиями выхода.";
          if (config.Drop && rule.Observe(count, now)) BeginLeave(now, "участники покидают конференцию");
          else if (config.Drop && rule.CandidateAt != 0) status = "Zoom: обнаружен отток. Подтверждаем перед выходом…";
        } else {
          if (phase == "watching") { rule.Observe(null, now); status = observed.Status ?? "Ожидаем элементы управления Zoom…"; }
          else { status = observed.Status ?? "Ожидаем вход в Zoom или допуск организатора."; }
          if (phase == "joining" && now - startedAt >= 15 * 60000L) BeginLeave(now, "вход не подтверждён за 15 минут");
        }
      } catch (Exception) {
        count = null; if (rule != null) rule.Observe(null, now);
        status = "Zoom не предоставил элементы управления. Проверьте приложение и разблокируйте рабочий стол.";
        if ((phase == "joining" && now - startedAt >= 15 * 60000L) || (phase == "leaving" && now - leaveAt >= 30000)) End(status + " Автоматизация остановлена.");
      }
    }
    private void BeginLeave(long now, string reason) {
      phase = "leaving"; leaveAt = now; exitReason = reason; status = "Выходим из Zoom: " + reason;
      automation.RequestLeave();
    }
    private void End(string message) { active = false; phase = "done"; status = message; count = null; automation.Reset(); }
  }
}
