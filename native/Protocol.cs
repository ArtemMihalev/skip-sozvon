using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web;
using System.Web.Script.Serialization;

namespace Sozvon {
  public static class Json {
    public static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 32 };
    public static Dictionary<string, object> Obj(params object[] pairs) {
      var result = new Dictionary<string, object>();
      for (int i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
      return result;
    }
    public static object Get(Dictionary<string, object> d, string key) { object value; return d != null && d.TryGetValue(key, out value) ? value : null; }
    public static string Text(Dictionary<string, object> d, string key) { return Convert.ToString(Get(d, key)); }
    public static bool Bool(Dictionary<string, object> d, string key) { return Get(d, key) is bool && (bool)Get(d, key); }
    public static long Number(Dictionary<string, object> d, string key) {
      var value = Get(d, key);
      if (value == null || value is bool || value is string) throw new ArgumentException("Invalid number: " + key);
      double number = Convert.ToDouble(value);
      if (Double.IsNaN(number) || Double.IsInfinity(number) || number != Math.Truncate(number) || number < 0 || number > 9007199254740991d) throw new ArgumentException("Invalid number: " + key);
      return Convert.ToInt64(value);
    }
  }
  public static class Framing {
    public static byte[] Read(Stream input) {
      var header = new byte[4];
      int first = input.ReadByte(); if (first == -1) return null; header[0] = (byte)first;
      Exact(input, header, 1, 3);
      uint length = (uint)(header[0] | header[1] << 8 | header[2] << 16 | header[3] << 24);
      if (length == 0 || length > 65536) throw new InvalidDataException("Invalid native message length");
      var bytes = new byte[length]; Exact(input, bytes, 0, (int)length); return bytes;
    }
    private static void Exact(Stream stream, byte[] bytes, int offset, int length) {
      while (length > 0) { int read = stream.Read(bytes, offset, length); if (read == 0) throw new EndOfStreamException(); offset += read; length -= read; }
    }
    public static void Write(Stream output, object message) {
      byte[] bytes = Encoding.UTF8.GetBytes(Json.Serializer.Serialize(message));
      if (bytes.Length > 1000000) throw new InvalidDataException("Response too large");
      int n = bytes.Length;
      output.Write(new byte[] { (byte)n, (byte)(n >> 8), (byte)(n >> 16), (byte)(n >> 24) }, 0, 4);
      output.Write(bytes, 0, bytes.Length); output.Flush();
    }
  }
  public sealed class ZoomLink {
    public string Id, Password, Host;
    public static ZoomLink Parse(string value) {
      Uri url;
      if (value.Length > 4096 || !Uri.TryCreate(value, UriKind.Absolute, out url) || url.Scheme != "https" || !url.IsDefaultPort || url.UserInfo.Length != 0) throw new ArgumentException("Нужна HTTPS-ссылка Zoom с /j/ и ID конференции.");
      string host = url.IdnHost.ToLowerInvariant();
      if (!(host == "zoom.us" || host.EndsWith(".zoom.us") || host == "zoom.com" || host.EndsWith(".zoom.com"))) throw new ArgumentException("Недопустимый домен Zoom.");
      var match = System.Text.RegularExpressions.Regex.Match(url.AbsolutePath, @"^/j/(\d{9,11})/?$");
      if (!match.Success) throw new ArgumentException("Поддерживаются ссылки Zoom /j/ с числовым ID.");
      string password = HttpUtility.ParseQueryString(url.Query)["pwd"] ?? "";
      if (password.Length > 1024) throw new ArgumentException("Слишком длинный код приглашения.");
      return new ZoomLink { Id = match.Groups[1].Value, Password = password, Host = host };
    }
    public string LaunchUri(string name) {
      return "zoommtg://" + Host + "/join?action=join&confno=" + Id + (Password.Length > 0 ? "&pwd=" + Uri.EscapeDataString(Password) : "") + (name.Length > 0 ? "&uname=" + Uri.EscapeDataString(name) : "");
    }
  }
}
