using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using Microsoft.Win32;

namespace Sozvon {
  public sealed class ZoomAutomation : IZoomAutomation {
    private IntPtr handle;
    private int processId;
    private long processStarted;
    private string runtimeId;
    private bool requestedLeave, rosterRequested;
    private long lastAction;
    private HashSet<string> baselineWindows = new HashSet<string>();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    public bool Installed { get { return FindExecutable() != null; } }
    public static string FindExecutable() {
      var candidates = new List<string>();
      foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
        using (var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\Zoom.exe")) if (key != null) candidates.Add(Convert.ToString(key.GetValue(null)));
        using (var key = hive.OpenSubKey(@"Software\Classes\zoommtg\shell\open\command")) {
          if (key != null) {
            var match = Regex.Match(Convert.ToString(key.GetValue(null)), "^\\s*\"([^\"]+Zoom\\.exe)\"", RegexOptions.IgnoreCase);
            if (match.Success) candidates.Add(match.Groups[1].Value);
          }
        }
      }
      foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) }) candidates.Add(Path.Combine(folder, @"Zoom\bin\Zoom.exe"));
      return candidates.FirstOrDefault(path => !String.IsNullOrWhiteSpace(path) && File.Exists(path) && String.Equals(Path.GetFileName(path), "Zoom.exe", StringComparison.OrdinalIgnoreCase));
    }
    private static void DesktopAvailable() {
      IntPtr desktop = OpenInputDesktop(0, false, 0x0001 | 0x0100);
      if (desktop == IntPtr.Zero) throw new InvalidOperationException("Разблокируйте рабочий стол Windows.");
      CloseDesktop(desktop);
    }
    private static List<AutomationElement> Windows() {
      var processes = Process.GetProcessesByName("Zoom");
      if (processes.Length == 0) return new List<AutomationElement>();
      var conditions = processes.Select(p => (Condition)new PropertyCondition(AutomationElement.ProcessIdProperty, p.Id)).ToArray();
      foreach (var process in processes) process.Dispose();
      Condition condition = conditions.Length == 1 ? conditions[0] : new OrCondition(conditions);
      return AutomationElement.RootElement.FindAll(TreeScope.Children, condition).Cast<AutomationElement>().ToList();
    }
    private static List<AutomationElement> Nodes(AutomationElement root) {
      var nodes = new List<AutomationElement>(); var queue = new Queue<AutomationElement>(); queue.Enqueue(root);
      while (queue.Count > 0 && nodes.Count < 2500) {
        var node = queue.Dequeue(); nodes.Add(node);
        foreach (AutomationElement child in node.FindAll(TreeScope.Children, Condition.TrueCondition)) { if (queue.Count + nodes.Count >= 2500) break; queue.Enqueue(child); }
      }
      return nodes;
    }
    private static string Name(AutomationElement el) { return (el.Current.Name ?? "").Trim(); }
    private static bool Match(string text, string pattern) { return Regex.IsMatch(text, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant); }
    private static AutomationElement Button(IEnumerable<AutomationElement> nodes, string pattern) {
      return nodes.FirstOrDefault(el => el.Current.ControlType == ControlType.Button && el.Current.IsEnabled && !el.Current.IsOffscreen && Match(Name(el), pattern));
    }
    private static bool Invoke(AutomationElement el) {
      if (el == null) return false;
      object pattern;
      if (!el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) return false;
      ((InvokePattern)pattern).Invoke(); return true;
    }
    public static int? ParseCount(IEnumerable<string> names) {
      var values = new HashSet<int>();
      foreach (string name in names) {
        var match = Regex.Match(name, @"^(?:Participants|Участники)\s*[,:(]?\s*(\d{1,6})\s*\)?(?:\s*[,\-]?\s*(?:Alt\+U|Альт\+U))?$", RegexOptions.IgnoreCase);
        int count;
        if (match.Success && Int32.TryParse(match.Groups[1].Value, out count) && count >= 1 && count <= 100000) values.Add(count);
      }
      return values.Count == 1 ? (int?)values.Single() : null;
    }
    private IEnumerable<string> CounterNames(List<AutomationElement> elements) {
      var names = new List<string>();
      foreach (var el in elements) {
        if (el.Current.ControlType != ControlType.Button && el.Current.ControlType != ControlType.Text && el.Current.ControlType != ControlType.TabItem) continue;
        string name = Name(el); names.Add(name);
        if (el.Current.ControlType != ControlType.Text && Match(name, @"^(?:Participants|Участники)$")) {
          var totals = el.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>().Select(Name).Where(n => Match(n, @"^\d{1,6}$")).Distinct().ToList();
          if (totals.Count == 1) names.Add(name + " (" + totals[0] + ")");
        }
      }
      return names;
    }
    private static AutomationElement LeaveButton(List<AutomationElement> nodes) {
      return Button(nodes, @"^(?:Leave(?: meeting)?|Выйти(?: из конференции)?|Покинуть конференцию)(?:\s*\(?Alt\+Q\)?)?$");
    }
    public void Start(ZoomLink link, string guestName) {
      DesktopAvailable();
      string executable = FindExecutable(); if (executable == null) throw new InvalidOperationException("Установите Zoom Workplace для Windows.");
      foreach (var root in Windows()) {
        var nodes = Nodes(root);
        if (LeaveButton(nodes) != null || Match(Name(root), @"^(?:Zoom Meeting|Конференция Zoom)(?:\b|$)")) throw new InvalidOperationException("В Zoom уже открыта конференция. Завершите её перед автоматическим входом.");
      }
      Reset();
      foreach (var root in Windows()) baselineWindows.Add(String.Join(".", root.GetRuntimeId()));
      // Pass only a reconstructed, encoded Zoom URI as one argument, never a
      // shell command or the original untrusted URL / protocol handler command.
      var info = new ProcessStartInfo(executable, "--url=\"" + link.LaunchUri(guestName) + "\"") { UseShellExecute = false };
      using (Process.Start(info)) { }
    }
    private void Bind(AutomationElement root) {
      handle = new IntPtr(root.Current.NativeWindowHandle); processId = root.Current.ProcessId;
      using (var process = Process.GetProcessById(processId)) processStarted = process.StartTime.ToUniversalTime().Ticks;
      runtimeId = String.Join(".", root.GetRuntimeId());
    }
    private AutomationElement Bound() {
      if (handle == IntPtr.Zero) return null;
      using (var process = Process.GetProcessById(processId)) if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != processStarted) return null;
      var root = AutomationElement.FromHandle(handle);
      if (root == null || root.Current.ProcessId != processId || String.Join(".", root.GetRuntimeId()) != runtimeId) return null;
      return root;
    }
    public ZoomObservation Observe(bool leaving, string guestName) {
      DesktopAvailable();
      if (handle == IntPtr.Zero) {
        foreach (var root in Windows()) {
          if (baselineWindows.Contains(String.Join(".", root.GetRuntimeId()))) continue;
          var nodes = Nodes(root);
          if (LeaveButton(nodes) != null && nodes.Any(el => Match(Name(el), @"^(?:Participants|Участники)(?:\s|\(|,|$)"))) { Bind(root); break; }
          var text = String.Join(" ", nodes.Where(el => el.Current.ControlType == ControlType.Text).Select(Name));
          if (Match(text, @"waiting (?:room|for the host)|host will let you in|зал(?:е)? ожидания|ожида(?:йте|ние).*организатор")) { Bind(root); break; }
          // Only exact prejoin actions. Never type passwords or submit login.
          if (DateTime.UtcNow.Ticks - lastAction > TimeSpan.FromSeconds(5).Ticks) {
            var noVideo = Button(nodes, @"^(?:Join without video|Войти без видео|Присоединиться без видео)$");
            if (Invoke(noVideo)) lastAction = DateTime.UtcNow.Ticks;
          }
        }
        if (handle == IntPtr.Zero) return new ZoomObservation { Status = "Zoom: ожидаем вход. Запросы входа в аккаунт и доступа подтвердите вручную." };
      }
      AutomationElement bound;
      try { bound = Bound(); } catch (ArgumentException) { bound = null; } catch (ElementNotAvailableException) { bound = null; }
      if (bound == null) return new ZoomObservation { Ended = true };
      var elements = Nodes(bound);
      if (leaving || requestedLeave) {
        var waitingText = String.Join(" ", elements.Where(el => el.Current.ControlType == ControlType.Text).Select(Name));
        if (Match(waitingText, @"waiting (?:room|for the host)|host will let you in|зал(?:е)? ожидания|ожида(?:йте|ние).*организатор")) {
          Invoke(Button(elements, @"^(?:Leave(?: meeting)?|Cancel|Выйти(?: из конференции)?|Отмена|Покинуть конференцию)$"));
          return new ZoomObservation { Status = "Zoom: выходим из зала ожидания…" };
        }
        var confirm = Button(elements, @"^(?:Leave meeting|Leave Meeting|Выйти из конференции|Покинуть конференцию)$");
        // Confirmation may be a separate Zoom-owned window. Require the same
        // process and exact leave text; never invoke End / End for everyone.
        if (confirm == null) {
          foreach (var dialog in Windows().Where(w => w.Current.ProcessId == processId && OwnedByBound(w))) {
            var nodes = Nodes(dialog);
            if (nodes.Any(el => Match(Name(el), @"(?:leave (?:this |the )?meeting|выйти из конференции|покинуть конференцию)"))) { confirm = Button(nodes, @"^(?:Leave(?: meeting)?|Выйти(?: из конференции)?|Покинуть конференцию)$"); if (confirm != null) break; }
          }
        }
        if (Invoke(confirm)) return new ZoomObservation { Status = "Zoom: подтверждение выхода нажато. Проверяем завершение…" };
        if (LeaveButton(elements) == null && Match(waitingText, @"you have left (?:the )?meeting|(?:this |the )?meeting has (?:been )?ended|вы вышли из конференции|конференция (?:была )?завершена")) return new ZoomObservation { LeaveConfirmed = true };
        if (DateTime.UtcNow.Ticks - lastAction > TimeSpan.FromSeconds(5).Ticks && Invoke(LeaveButton(elements))) lastAction = DateTime.UtcNow.Ticks;
        return new ZoomObservation { Status = "Zoom: ожидаем подтверждение выхода…" };
      }
      var leave = LeaveButton(elements);
      if (leave == null) return new ZoomObservation { Status = "Zoom: панель управления недоступна, счётчик не используется." };
      // Correct media state after connecting too, without toggling unknown state.
      Invoke(Button(elements, @"^(?:Mute(?: my audio)?|Выключить микрофон|Отключить микрофон)(?:\s*\(?Alt\+A\)?)?$"));
      Invoke(Button(elements, @"^(?:Stop video|Stop my video|Остановить видео|Выключить видео)(?:\s*\(?Alt\+V\)?)?$"));
      var counterNames = new List<string>(CounterNames(elements));
      foreach (var panel in Windows().Where(w => w.Current.ProcessId == processId && OwnedByBound(w))) counterNames.AddRange(CounterNames(Nodes(panel)));
      int? count = ParseCount(counterNames);
      if (!count.HasValue && !rosterRequested) { rosterRequested = Invoke(Button(elements, @"^(?:Participants|Участники)(?:\s*\(\d+\))?(?:\s*\(?Alt\+U\)?)?$")); }
      return new ZoomObservation { Joined = true, Count = count, Status = count.HasValue ? "Подключено к Zoom. Следим за условиями выхода." : "Подключено к Zoom. Счётчик участников недоступен; выход по времени работает." };
    }
    public void RequestLeave() {
      requestedLeave = true;
      if (handle == IntPtr.Zero) return;
      DesktopAvailable(); var root = Bound(); if (root != null) Invoke(LeaveButton(Nodes(root)));
      lastAction = DateTime.UtcNow.Ticks;
    }
    private bool OwnedByBound(AutomationElement root) {
      IntPtr owner = new IntPtr(root.Current.NativeWindowHandle);
      for (int i = 0; i < 8 && owner != IntPtr.Zero; i++) { owner = GetWindow(owner, 4); if (owner == handle) return true; }
      return false;
    }
    public void Reset() { handle = IntPtr.Zero; processId = 0; processStarted = 0; runtimeId = null; requestedLeave = false; rosterRequested = false; lastAction = 0; baselineWindows.Clear(); }
  }
}
