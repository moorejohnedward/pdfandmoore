using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PdfAndMoore.Services;

/// <summary>User settings shown in the editor's Settings dialog.</summary>
public sealed class AppSettings
{
    public string ApiKey { get; set; } = "";
    public string Model { get; set; } = "claude-sonnet-5-5";
    public string UserName { get; set; } = "";

    /// <summary>"local" = free on-device AI; "api" = Claude with an API key; "web" = signed in to claude.ai.</summary>
    public string ClaudeMode { get; set; } = "";

    /// <summary>Where claude.ai opens in "web" mode: "app" (a window of this app) or "browser".</summary>
    public string ClaudeWhere { get; set; } = "app";

    /// <summary>Which on-device AI model to use (downloaded once, then offline).</summary>
    public string LocalModel { get; set; } = "";
}

/// <summary>
/// Saves settings to %APPDATA%\PdfAndMoore\settings.json.
/// The Claude API key is encrypted with Windows DPAPI, so only your Windows account can read it.
/// </summary>
public sealed class SettingsStore
{
    private static readonly string Folder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore");

    private static readonly string FilePath = Path.Combine(Folder, "settings.json");

    private sealed class StoredSettings
    {
        public string ProtectedApiKey { get; set; } = "";
        public string Model { get; set; } = "claude-sonnet-5-5";
        public string UserName { get; set; } = "";
        public string ClaudeMode { get; set; } = "";
        public string ClaudeWhere { get; set; } = "app";
        public string LocalModel { get; set; } = "";
    }

    public AppSettings Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new AppSettings();
            var stored = JsonSerializer.Deserialize<StoredSettings>(File.ReadAllText(FilePath)) ?? new StoredSettings();
            return new AppSettings
            {
                ApiKey = Unprotect(stored.ProtectedApiKey),
                Model = string.IsNullOrWhiteSpace(stored.Model) ? "claude-sonnet-5-5" : stored.Model,
                UserName = stored.UserName,
                ClaudeMode = stored.ClaudeMode,
                ClaudeWhere = string.IsNullOrWhiteSpace(stored.ClaudeWhere) ? "app" : stored.ClaudeWhere,
                LocalModel = stored.LocalModel,
            };
        }
        catch (Exception)
        {
            // A damaged settings file should never stop the app from starting.
            return new AppSettings();
        }
    }

    public void Save(AppSettings settings)
    {
        Directory.CreateDirectory(Folder);
        var stored = new StoredSettings
        {
            ProtectedApiKey = Protect(settings.ApiKey),
            Model = settings.Model,
            UserName = settings.UserName,
            ClaudeMode = settings.ClaudeMode,
            ClaudeWhere = settings.ClaudeWhere,
            LocalModel = settings.LocalModel,
        };
        File.WriteAllText(FilePath, JsonSerializer.Serialize(stored, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static string Protect(string plain)
    {
        if (string.IsNullOrEmpty(plain)) return "";
        byte[] data = ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(data);
    }

    private static string Unprotect(string stored)
    {
        if (string.IsNullOrEmpty(stored)) return "";
        try
        {
            byte[] data = ProtectedData.Unprotect(Convert.FromBase64String(stored), null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(data);
        }
        catch (CryptographicException)
        {
            return ""; // saved by a different Windows user: ask for the key again
        }
    }
}
