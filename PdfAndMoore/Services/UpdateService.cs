// PDF and Moore - in-app updater
// Checks GitHub Releases (github.com/moorejohnedward/pdfandmoore) for a newer version,
// downloads the new .exe, checks its SHA-256 fingerprint, and swaps it in place of the
// running .exe. The new version starts the next time PDF and Moore opens, or right away
// with "Restart now" (which closes windows normally, so unsaved work is still asked about).
//
// How the swap works: Windows won't let you overwrite a running .exe, but it DOES let you
// rename it. So the running file becomes "<name>.exe.old", the download moves into its
// place, and the next launch deletes the .old file. A copy installed in Program Files needs
// administrator rights for the swap, so Windows asks once (UAC) in that case.

using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

namespace PdfAndMoore.Services;

public sealed record UpdateInfo(
    Version Version,
    string Tag,
    string ReleaseNotes,
    string DownloadUrl,
    long DownloadSize,
    string? Sha256Url,
    string PageUrl);

public static class UpdateService
{
    // GitHub account and repo the app updates from.
    public const string GitHubOwner = "moorejohnedward";
    public const string GitHubRepo = "pdfandmoore";
    private const string ExeAssetName = "PdfAndMoore.exe";
    private const string ShaAssetName = "PdfAndMoore.exe.sha256";

    private static readonly HttpClient Http = CreateClient();

    private static readonly string SettingsDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore");
    private static readonly string SettingsFile = Path.Combine(SettingsDir, "update-settings.json");

    /// <summary>Set after an update is installed: when the app closes, it starts the new version.</summary>
    public static bool RelaunchOnExit { get; set; }

    /// <summary>True once an update has been swapped in during this session.</summary>
    public static bool Installed { get; private set; }

    public static Version CurrentVersion
    {
        get
        {
            var v = Assembly.GetEntryAssembly()?.GetName().Version ?? new Version(0, 0, 0);
            return new Version(v.Major, v.Minor, Math.Max(v.Build, 0));
        }
    }

    public static string CurrentExePath =>
        Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "PDF and Moore.exe");

    private static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("PdfAndMoore-Updater"); // GitHub's API requires a User-Agent
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    /// <summary>Call once at startup: removes the old .exe left behind by the last update.</summary>
    public static void CleanupAfterUpdate()
    {
        var old = CurrentExePath + ".old";
        for (int i = 0; i < 10 && File.Exists(old); i++)
        {
            try { File.Delete(old); }
            catch (UnauthorizedAccessException) { break; } // Program Files copy; harmless to leave
            catch { Thread.Sleep(300); }                   // the previous copy may still be closing
        }
    }

    /// <summary>Returns the newest release if it's newer than this copy, otherwise null.</summary>
    public static async Task<UpdateInfo?> CheckAsync(CancellationToken ct = default)
    {
        var url = $"https://api.github.com/repos/{GitHubOwner}/{GitHubRepo}/releases/latest";
        using var resp = await Http.GetAsync(url, ct).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode) return null; // offline, no releases yet, or rate-limited

        using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
        var root = doc.RootElement;

        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (!TryParseVersion(tag, out var latest) || latest <= CurrentVersion) return null;

        string? exeUrl = null, shaUrl = null;
        long size = 0;
        foreach (var a in root.GetProperty("assets").EnumerateArray())
        {
            var name = a.GetProperty("name").GetString();
            if (string.Equals(name, ExeAssetName, StringComparison.OrdinalIgnoreCase))
            {
                exeUrl = a.GetProperty("browser_download_url").GetString();
                size = a.GetProperty("size").GetInt64();
            }
            else if (string.Equals(name, ShaAssetName, StringComparison.OrdinalIgnoreCase))
            {
                shaUrl = a.GetProperty("browser_download_url").GetString();
            }
        }
        if (exeUrl is null || shaUrl is null) return null;

        return new UpdateInfo(
            latest, tag,
            root.TryGetProperty("body", out var b) ? b.GetString() ?? "" : "",
            exeUrl, size, shaUrl,
            root.TryGetProperty("html_url", out var h) ? h.GetString() ?? "" : "");
    }

    /// <summary>Downloads, verifies and installs the update. The new version runs on the next start.</summary>
    public static async Task DownloadAndInstallAsync(UpdateInfo info, IProgress<double>? progress, CancellationToken ct = default)
    {
        var exe = CurrentExePath;
        var oldFile = exe + ".old";
        var tempDir = Path.Combine(Path.GetTempPath(), "PdfAndMoore-update");
        Directory.CreateDirectory(tempDir);
        var download = Path.Combine(tempDir, ExeAssetName);

        // 1) Download to a temporary folder (works even when the app is in Program Files)
        using (var resp = await Http.GetAsync(info.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
        {
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? info.DownloadSize;
            await using var src = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await using var dst = new FileStream(download, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
            var buffer = new byte[81920];
            long read = 0;
            int n;
            while ((n = await src.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                await dst.WriteAsync(buffer.AsMemory(0, n), ct).ConfigureAwait(false);
                read += n;
                if (total > 0) progress?.Report((double)read / total);
            }
        }

        // 2) Verify: right size, and matches the published SHA-256 fingerprint
        if (info.DownloadSize > 0 && new FileInfo(download).Length != info.DownloadSize)
        {
            File.Delete(download);
            throw new InvalidDataException("The download was incomplete. Please try again.");
        }
        var expected = (await Http.GetStringAsync(info.Sha256Url!, ct).ConfigureAwait(false))
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim().ToLowerInvariant();
        string actual;
        await using (var fs = File.OpenRead(download))
            actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct).ConfigureAwait(false)).ToLowerInvariant();
        if (string.IsNullOrEmpty(expected) || expected != actual)
        {
            File.Delete(download);
            throw new InvalidDataException("The download didn't pass its safety check, so it wasn't installed.");
        }

        // 3) Swap: rename the running exe out of the way, move the new one in
        try
        {
            if (File.Exists(oldFile)) File.Delete(oldFile);
            File.Move(exe, oldFile);
            try { File.Move(download, exe); }
            catch { File.Move(oldFile, exe); throw; } // put the original back if anything went wrong
        }
        catch (UnauthorizedAccessException)
        {
            SwapAsAdmin(exe, oldFile, download); // installed in Program Files
        }
        Installed = true;
    }

    /// <summary>For a copy in a protected folder: Windows asks for permission once, then PowerShell does the swap.</summary>
    private static void SwapAsAdmin(string exe, string oldFile, string download)
    {
        static string Q(string s) => "'" + s.Replace("'", "''") + "'";
        string script =
            $"$ErrorActionPreference='Stop'; " +
            $"if (Test-Path -LiteralPath {Q(oldFile)}) {{ Remove-Item -LiteralPath {Q(oldFile)} -Force -ErrorAction SilentlyContinue }}; " +
            $"Move-Item -LiteralPath {Q(exe)} -Destination {Q(oldFile)} -Force; " +
            $"try {{ Copy-Item -LiteralPath {Q(download)} -Destination {Q(exe)} -Force }} " +
            $"catch {{ Move-Item -LiteralPath {Q(oldFile)} -Destination {Q(exe)} -Force; exit 1 }}";
        var psi = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
            Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + script.Replace("\"", "\\\"") + "\"",
        };
        Process? p;
        try { p = Process.Start(psi); }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new InvalidOperationException("Windows needs your permission to update the copy in this folder, and it wasn't given.");
        }
        p?.WaitForExit();
        if (p == null || p.ExitCode != 0 || !File.Exists(exe))
            throw new InvalidOperationException("The update couldn't be copied into the app's folder.");
    }

    /// <summary>Starts the new version. Called when the app exits after "Restart now".</summary>
    public static void RelaunchIfRequested()
    {
        if (!RelaunchOnExit || !Installed) return;
        try { Process.Start(new ProcessStartInfo(CurrentExePath) { UseShellExecute = true, Arguments = "--updated" }); }
        catch { }
    }

    // ---- "Skip this version" and auto-check preferences ------------------

    private sealed class Settings
    {
        public string? SkippedVersion { get; set; }
        public bool CheckOnStartup { get; set; } = true;
    }

    private static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(SettingsFile)) ?? new(); }
        catch { return new(); }
    }

    private static void Save(Settings s)
    {
        try { Directory.CreateDirectory(SettingsDir); File.WriteAllText(SettingsFile, JsonSerializer.Serialize(s)); }
        catch { }
    }

    public static bool CheckOnStartup
    {
        get => Load().CheckOnStartup;
        set { var s = Load(); s.CheckOnStartup = value; Save(s); }
    }

    public static bool IsSkipped(UpdateInfo info) => Load().SkippedVersion == info.Version.ToString();

    public static void Skip(UpdateInfo info) { var s = Load(); s.SkippedVersion = info.Version.ToString(); Save(s); }

    private static bool TryParseVersion(string tag, out Version v)
    {
        var t = tag.Trim().TrimStart('v', 'V');
        var dash = t.IndexOf('-');
        if (dash >= 0) t = t[..dash];
        if (Version.TryParse(t, out var parsed))
        {
            v = new Version(parsed.Major, parsed.Minor, Math.Max(parsed.Build, 0));
            return true;
        }
        v = new Version(0, 0, 0);
        return false;
    }
}
