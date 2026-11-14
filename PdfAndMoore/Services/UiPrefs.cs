using System.Text.Json;

namespace PdfAndMoore.Services;

/// <summary>
/// Look &amp; feel choices (v9), saved in %APPDATA%\PdfAndMoore\ui.json so the Windows parts
/// (start-up splash, update window) match the theme the web page uses.
/// </summary>
public sealed class UiPrefs
{
    /// <summary>"dark" (default) or "light".</summary>
    public string Theme { get; set; } = "dark";

    /// <summary>"normal", "large" (default) or "xl": how big buttons and text are.</summary>
    public string TextSize { get; set; } = "large";

    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore", "ui.json");

    public static UiPrefs Load()
    {
        try { return JsonSerializer.Deserialize<UiPrefs>(File.ReadAllText(FilePath)) ?? new UiPrefs(); }
        catch { return new UiPrefs(); }
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
        }
        catch { }
    }

    public bool IsDark => !string.Equals(Theme, "light", StringComparison.OrdinalIgnoreCase);
}
