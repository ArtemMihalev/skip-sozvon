using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace Sozvon {
  public static class Program {
    private static readonly object Gate = new object();
    private static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    [MTAThread]
    public static int Main(string[] args) {
      Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
      var controller = new Controller(new ZoomAutomation());
      bool failed = false;
      using (var timer = new Timer(delegate {
        lock (Gate) {
          if (failed) return;
          try {
            controller.Tick(Now());
            var state = controller.State(Now());
            if (Json.Text(state, "runId").Length > 0) Framing.Write(output, Json.Obj("type", "status", "state", state));
          } catch (IOException) { failed = true; }
        }
      }, null, 1000, 1000)) {
        try {
          byte[] bytes;
          while (!failed && (bytes = Framing.Read(input)) != null) {
            lock (Gate) {
              var message = Json.Serializer.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes));
              Dictionary<string, object> reply;
              try { reply = controller.Handle(message, Now()); reply["ok"] = true; }
              catch (Exception error) { reply = Json.Obj("ok", false, "error", error is ArgumentException || error is InvalidOperationException ? error.Message : "Не удалось управлять Zoom. Проверьте приложение и доступность рабочего стола."); }
              reply["type"] = "reply"; reply["requestId"] = Json.Text(message, "requestId");
              Framing.Write(output, reply);
            }
          }
          return 0;
        } catch (Exception) { return 1; }
      }
      // EOF means Chrome disconnected: the process and its polling stop. The
      // meeting is left open rather than ending an unrelated user's call.
    }
  }
}
