using Microsoft.Win32;

namespace PdfAndMoore.Services;

/// <summary>
/// Lets John's other apps find PDF and Moore (v9.8). Every start writes this copy's location to the standard
/// Windows "App Paths" list for the current user, so KonaSnap (or Win+R "PdfAndMoore") can start it from
/// wherever it is installed or built. Nothing here needs admin rights.
/// </summary>
internal static class AppLinks
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\App Paths\PdfAndMoore.exe";

    public static void Register()
    {
        try
        {
            string? exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return;
            using RegistryKey k = Registry.CurrentUser.CreateSubKey(Key);
            if (!string.Equals(k.GetValue("") as string, exe, StringComparison.OrdinalIgnoreCase)) k.SetValue("", exe);
            string? dir = Path.GetDirectoryName(exe);
            if (dir != null && !string.Equals(k.GetValue("Path") as string, dir, StringComparison.OrdinalIgnoreCase)) k.SetValue("Path", dir);
        }
        catch
        {
            // Being findable is a convenience; never let it stop the app from starting.
        }
    }
}
