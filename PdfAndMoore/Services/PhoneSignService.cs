using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace PdfAndMoore.Services;

/// <summary>
/// Sign on your phone (v9.6). While the signature window is open, a tiny web server runs on this PC.
/// The phone (on the same Wi-Fi, or on Tailscale) scans a QR code with a one-time link, you sign with a
/// finger or stylus, and the phone sends the signature back as a PNG. Nothing goes through the internet.
/// The link stops working after one signature, after 15 minutes, or when the window closes.
/// </summary>
public sealed class PhoneSignService : IDisposable
{
    /// <summary>Same port every time, so Windows Firewall only has to ask once.</summary>
    public const int PreferredPort = 47321;
    private const int MaxHeaderBytes = 16 * 1024;
    private const int MaxBodyBytes = 6 * 1024 * 1024;

    private readonly object _gate = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;
    private byte[] _token = Array.Empty<byte>();
    private string _tokenText = "";
    private DateTime _expiresUtc;

    /// <summary>A signature arrived (PNG data URL). Raised on a background thread.</summary>
    public event Action<string>? SignatureReceived;
    /// <summary>The phone opened the link. Raised on a background thread.</summary>
    public event Action? PhoneConnected;

    public sealed record Address(string Ip, string Kind, string Url);

    /// <summary>Starts (or restarts) listening with a new one-time link. Returns the links to show as QR codes.</summary>
    public object Start()
    {
        lock (_gate)
        {
            StopLocked();
            _tokenText = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            _token = Encoding.ASCII.GetBytes(_tokenText);
            _expiresUtc = DateTime.UtcNow.AddMinutes(15);
            _cts = new CancellationTokenSource(TimeSpan.FromMinutes(15));
            try
            {
                _listener = new TcpListener(IPAddress.Any, PreferredPort);
                _listener.Start();
            }
            catch (SocketException)
            {
                // Port busy (another copy of the app?): take any free one.
                _listener = new TcpListener(IPAddress.Any, 0);
                _listener.Start();
            }
            int port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = AcceptLoopAsync(_listener, _cts.Token);
            var addresses = LocalAddresses().Select(a => new Address(a.ip, a.kind, $"http://{a.ip}:{port}/sign/{_tokenText}")).ToList();
            return new { port, addresses };
        }
    }

    public void Stop()
    {
        lock (_gate) StopLocked();
    }

    private void StopLocked()
    {
        try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        try { _listener?.Stop(); } catch (SocketException) { }
        _cts?.Dispose();
        _cts = null;
        _listener = null;
        _token = Array.Empty<byte>();
        _tokenText = "";
    }

    public void Dispose() => Stop();

    /// <summary>This PC's addresses a phone could reach: home/shop network first, then Tailscale.</summary>
    private static List<(string ip, string kind)> LocalAddresses()
    {
        var found = new List<(string ip, string kind, int rank)>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            IPInterfaceProperties props;
            try { props = nic.GetIPProperties(); } catch (NetworkInformationException) { continue; }
            bool hasGateway = props.GatewayAddresses.Any(g => g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
            foreach (var ua in props.UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                byte[] b = ua.Address.GetAddressBytes();
                if (b[0] == 169 && b[1] == 254) continue; // no network yet
                bool tailscale = b[0] == 100 && (b[1] & 0xC0) == 64; // 100.64.0.0/10
                bool privateLan = b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);
                string kind = tailscale ? "Tailscale"
                    : nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? "Wi-Fi"
                    : privateLan ? "Local network" : "Other network";
                int rank = tailscale ? 2 : privateLan && hasGateway ? 0 : privateLan ? 1 : 3;
                found.Add((ua.Address.ToString(), kind, rank));
            }
        }
        return found.OrderBy(f => f.rank).Select(f => (f.ip, f.kind)).Distinct().ToList();
    }

    private async Task AcceptLoopAsync(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await listener.AcceptTcpClientAsync(ct); }
            catch (Exception) { break; } // stopped
            _ = Task.Run(() => HandleClientAsync(client, ct));
        }
        // Timed out or stopped: let go of the port.
        try { listener.Stop(); } catch (SocketException) { }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(60));
                NetworkStream stream = client.GetStream();

                // Read the request line and headers.
                var head = new MemoryStream();
                var buf = new byte[4096];
                int headerEnd = -1;
                while (headerEnd < 0)
                {
                    int n = await stream.ReadAsync(buf, timeout.Token);
                    if (n == 0) return;
                    head.Write(buf, 0, n);
                    if (head.Length > MaxHeaderBytes) { await RespondAsync(stream, 431, "text/plain", "Too big."); return; }
                    headerEnd = IndexOf(head.GetBuffer(), (int)head.Length, "\r\n\r\n"u8);
                }
                byte[] all = head.ToArray();
                string headerText = Encoding.ASCII.GetString(all, 0, headerEnd);
                string[] lines = headerText.Split("\r\n");
                string[] first = lines[0].Split(' ');
                if (first.Length < 2) { await RespondAsync(stream, 400, "text/plain", "Bad request."); return; }
                string method = first[0].ToUpperInvariant();
                string path = first[1].Split('?')[0];

                // /sign/<token>
                const string prefix = "/sign/";
                byte[] given = path.StartsWith(prefix, StringComparison.Ordinal) ? Encoding.ASCII.GetBytes(path[prefix.Length..]) : Array.Empty<byte>();
                bool valid;
                lock (_gate) valid = _token.Length > 0 && DateTime.UtcNow < _expiresUtc && CryptographicOperations.FixedTimeEquals(given, _token);
                if (!valid)
                {
                    await RespondAsync(stream, 404, "text/html; charset=utf-8", ExpiredPage);
                    return;
                }

                if (method == "GET")
                {
                    await RespondAsync(stream, 200, "text/html; charset=utf-8", PhonePage.Html);
                    PhoneConnected?.Invoke();
                    return;
                }
                if (method != "POST") { await RespondAsync(stream, 405, "text/plain", "Not allowed."); return; }

                int length = 0;
                foreach (string line in lines.Skip(1))
                {
                    int colon = line.IndexOf(':');
                    if (colon > 0 && line[..colon].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                        int.TryParse(line[(colon + 1)..].Trim(), out length);
                }
                if (length <= 0 || length > MaxBodyBytes) { await RespondAsync(stream, 413, "text/plain", "The signature was too big to send."); return; }

                var body = new MemoryStream();
                int already = all.Length - (headerEnd + 4);
                if (already > 0) body.Write(all, headerEnd + 4, Math.Min(already, length));
                while (body.Length < length)
                {
                    int n = await stream.ReadAsync(buf.AsMemory(0, (int)Math.Min(buf.Length, length - body.Length)), timeout.Token);
                    if (n == 0) break;
                    body.Write(buf, 0, n);
                }
                string dataUrl = Encoding.ASCII.GetString(body.ToArray()).Trim();
                if (!IsPngDataUrl(dataUrl)) { await RespondAsync(stream, 400, "text/plain", "That wasn't a signature picture."); return; }

                // One signature per link: the next one needs a new QR code.
                lock (_gate) _token = Array.Empty<byte>();
                await RespondAsync(stream, 200, "text/plain", "ok");
                SignatureReceived?.Invoke(dataUrl);
            }
            catch (Exception)
            {
                // A phone that walks away mid-request is not an error worth showing.
            }
        }
    }

    private static bool IsPngDataUrl(string s)
    {
        const string head = "data:image/png;base64,";
        if (!s.StartsWith(head, StringComparison.Ordinal)) return false;
        try
        {
            byte[] png = Convert.FromBase64String(s[head.Length..]);
            return png.Length > 8 && png[0] == 0x89 && png[1] == 0x50 && png[2] == 0x4E && png[3] == 0x47;
        }
        catch (FormatException) { return false; }
    }

    private static int IndexOf(byte[] data, int length, ReadOnlySpan<byte> find)
    {
        int i = data.AsSpan(0, length).IndexOf(find);
        return i;
    }

    private static async Task RespondAsync(NetworkStream stream, int code, string type, string body)
    {
        string reason = code switch { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 405 => "Method Not Allowed", 413 => "Payload Too Large", 431 => "Request Header Fields Too Large", _ => "Error" };
        byte[] content = Encoding.UTF8.GetBytes(body);
        string headers =
            $"HTTP/1.1 {code} {reason}\r\n" +
            $"Content-Type: {type}\r\n" +
            $"Content-Length: {content.Length}\r\n" +
            "Cache-Control: no-store\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Referrer-Policy: no-referrer\r\n" +
            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:\r\n" +
            "Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(headers));
        await stream.WriteAsync(content);
        await stream.FlushAsync();
    }

    private const string ExpiredPage =
        "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>PDF and Moore</title>" +
        "<body style='font-family:system-ui,sans-serif;background:#0f1b2d;color:#eaf1f8;padding:32px;font-size:18px;line-height:1.5'>" +
        "<h2>This signing link has ended</h2><p>Links work once and for 15 minutes. On your PC, open <b>Sign</b> › <b>Phone</b> again for a new QR code.</p>";
}
