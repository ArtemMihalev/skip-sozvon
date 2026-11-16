using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Sozvon {
  public sealed class FakeZoom : IZoomAutomation {
    public bool Installed { get { return true; } }
    public int Starts, Leaves, Resets;
    public ZoomObservation Next = new ZoomObservation();
    public void Start(ZoomLink link, string name) { Starts++; }
    public ZoomObservation Observe(bool leaving, string name) { return Next; }
    public void RequestLeave() { Leaves++; }
    public void Reset() { Resets++; }
  }
  public static class NativeTests {
    private static int passed;
    private static void Check(bool ok, string label) { if (!ok) throw new Exception("FAIL: " + label); passed++; }
    private static void Throws(Action action, string label) { try { action(); } catch (Exception) { passed++; return; } throw new Exception("FAIL (expected rejection): " + label); }
    private static Dictionary<string, object> Config(bool timed, long deadline) { return Json.Obj("timed", timed, "deadline", deadline, "drop", true, "percent", 30, "minimum", 3, "windowSeconds", 120, "graceSeconds", 5); }
    private static Dictionary<string, object> Start(string id, bool timed, long deadline) { return Json.Obj("command", "START", "runId", id, "url", "https://us02web.zoom.us/j/12345678901?pwd=hello%2Bworld", "guestName", "Test Guest", "zoomPrepared", true, "config", Config(timed, deadline)); }
    public static int Main() {
      try {
        var link = ZoomLink.Parse("https://us02web.zoom.us/j/12345678901?pwd=a%2Bb");
        Check(link.Id == "12345678901" && link.Password == "a+b", "encoded invite preserved");
        Check(link.LaunchUri("Иван & name").Contains("pwd=a%2Bb") && !link.LaunchUri("x\"y").Contains("\""), "URI injection escaped");
        foreach (var url in new[] { "http://zoom.us/j/12345678901", "https://zoom.us.evil.test/j/12345678901", "https://user@zoom.us/j/12345678901", "https://zoom.us/my/name", "https://zoom.us/j/123", "file:///Zoom.exe" }) Throws(delegate { ZoomLink.Parse(url); }, "bad URL");
        Check(ZoomAutomation.ParseCount(new[] { "Participants (20)", "Участники (20)" }) == 20, "counter");
        Check(ZoomAutomation.ParseCount(new[] { "Participants (20)", "Participants (19)" }) == null, "ambiguous counter");
        Check(ZoomAutomation.ParseCount(new[] { "John 20", "Invite participants (2)", "Participants (0)" }) == null, "not a counter");
        var rule = new DropRule(ExitConfig.Parse(Config(false, 0)));
        Check(!rule.Observe(20, 100000), "baseline"); Check(!rule.Observe(14, 101000), "countdown");
        for (int i = 102; i < 106; i++) rule.Observe(14, i * 1000);
        Check(rule.Observe(14, 106000), "confirmed drop");
        rule.Observe(null, 107000); Check(!rule.Observe(1, 108000) && rule.CandidateAt == 0, "missing is not zero");
        rule.Observe(20, 109000); rule.Observe(14, 110000); rule.Observe(19, 111000); Check(rule.CandidateAt == 0, "recovery");
        rule.Observe(14, 112000); Check(!rule.Observe(14, 140000) && rule.CandidateAt == 0, "stale resets");
        var fake = new FakeZoom(); var engine = new Controller(fake); string id = Guid.NewGuid().ToString();
        engine.Handle(Start(id, true, 110000), 100000);
        Check(fake.Starts == 1, "start"); Throws(delegate { engine.Handle(Start(Guid.NewGuid().ToString(), true, 110000), 100000); }, "overlap");
        fake.Next = new ZoomObservation { Joined = false, Status = "Lobby" }; engine.Tick(101000);
        Check(Json.Text(engine.State(101000), "phase") == "joining", "lobby is not joined");
        fake.Next = new ZoomObservation { Joined = true, Count = 20 }; engine.Tick(102000);
        Check(Json.Text(engine.State(102000), "phase") == "watching", "joined");
        engine.Tick(110000); Check(fake.Leaves == 1 && Json.Bool(engine.State(110000), "active"), "deadline requests and waits for proof");
        fake.Next = new ZoomObservation { LeaveConfirmed = true }; engine.Tick(111000);
        Check(!Json.Bool(engine.State(111000), "active"), "verified leave");
        engine.Handle(Start(id, false, 0), 200000);
        Throws(delegate { engine.Handle(Json.Obj("command", "STOP", "runId", Guid.NewGuid().ToString()), 201000); }, "foreign run stop");
        engine.Handle(Json.Obj("command", "STOP", "runId", id), 202000);
        Check(fake.Leaves == 1 && !Json.Bool(engine.State(202000), "active"), "stop leaves meeting untouched");
        engine.Handle(Start(id, true, 310000), 300000); fake.Next = new ZoomObservation { Joined = true, Count = 20 };
        engine.Tick(310000); engine.Tick(341000); Check(!Json.Bool(engine.State(341000), "active") && Json.Text(engine.State(341000), "status").Contains("Не удалось"), "failed leave never reports success");
        var message = Json.Obj("hello", "Привет"); var stream = new MemoryStream(); Framing.Write(stream, message); stream.Position = 0;
        Check(Encoding.UTF8.GetString(Framing.Read(stream)).Contains("Привет") && Framing.Read(stream) == null, "native framing UTF8 and EOF");
        Throws(delegate { Framing.Read(new MemoryStream(new byte[] { 255, 255, 255, 127 })); }, "oversized frame");
        Throws(delegate { Framing.Read(new MemoryStream(new byte[] { 5, 0, 0, 0, 1 })); }, "truncated frame");
        Console.WriteLine("Native tests passed: " + passed); return 0;
      } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
  }
}
