using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace PdfAndMoore.Services;

/// <summary>
/// Lets Windows know PDF and Moore can open PDF, Word, Excel and PowerPoint files, so it shows up in
/// "Open with" and in Settings › Apps › Default apps. Windows only lets *you* pick the default app,
/// so after registering, the Default apps page for PDF and Moore is opened for you to confirm.
/// Everything is written for your Windows account only (HKEY_CURRENT_USER) - no admin rights needed.
/// </summary>
public static class FileAssociations
{
    private const string AppName = "PDF and Moore";
    private const string CapabilitiesKey = @"Software\PdfAndMoore\Capabilities";

    private static readonly (string ProgId, string Description, string[] Extensions)[] Groups =
    {
        ("PdfAndMoore.Pdf", "PDF document", new[] { ".pdf" }),
        ("PdfAndMoore.Word", "Word document", new[] { ".docx", ".doc", ".docm", ".dotx", ".dot", ".rtf", ".odt" }),
        ("PdfAndMoore.Excel", "Excel workbook", new[] { ".xlsx", ".xls", ".xlsm", ".xlsb", ".csv", ".tsv", ".ods" }),
        ("PdfAndMoore.PowerPoint", "PowerPoint presentation", new[] { ".pptx", ".ppt", ".pptm", ".ppsx", ".odp" }),
    };

    [DllImport("shell32.dll")]
    private static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    private const int SHCNE_ASSOCCHANGED = 0x08000000;

    public static bool IsRegistered
    {
        get
        {
            using RegistryKey? k = Registry.CurrentUser.OpenSubKey(CapabilitiesKey);
            return k != null;
        }
    }

    /// <summary>Registers the file types for this .exe. Returns a short message for the person.</summary>
    public static string Register(bool openSettings)
    {
        string exe = Environment.ProcessPath ?? throw new InvalidOperationException("Couldn't find the app's .exe.");
        string command = $"\"{exe}\" \"%1\"";
        string icon = $"\"{exe}\",0";

        using (RegistryKey classes = Registry.CurrentUser.CreateSubKey(@"Software\Classes"))
        using (RegistryKey cap = Registry.CurrentUser.CreateSubKey(CapabilitiesKey))
        using (RegistryKey capFiles = cap.CreateSubKey("FileAssociations"))
        using (RegistryKey app = classes.CreateSubKey(@"Applications\" + Path.GetFileName(exe)))
        using (RegistryKey appTypes = app.CreateSubKey("SupportedTypes"))
        {
            cap.SetValue("ApplicationName", AppName);
            cap.SetValue("ApplicationDescription", "Edit PDFs, Word documents, Excel spreadsheets and PowerPoint presentations.");
            cap.SetValue("ApplicationIcon", icon);

            app.SetValue("FriendlyAppName", AppName);
            using (RegistryKey appCmd = app.CreateSubKey(@"shell\open\command")) appCmd.SetValue("", command);

            foreach (var (progId, description, extensions) in Groups)
            {
                using (RegistryKey prog = classes.CreateSubKey(progId))
                {
                    prog.SetValue("", description);
                    prog.SetValue("FriendlyTypeName", description);
                    using (RegistryKey defIcon = prog.CreateSubKey("DefaultIcon")) defIcon.SetValue("", icon);
                    using (RegistryKey cmd = prog.CreateSubKey(@"shell\open\command")) cmd.SetValue("", command);
                }
                foreach (string ext in extensions)
                {
                    using (RegistryKey owp = classes.CreateSubKey(ext + @"\OpenWithProgids"))
                        owp.SetValue(progId, Array.Empty<byte>(), RegistryValueKind.None);
                    capFiles.SetValue(ext, progId);
                    appTypes.SetValue(ext, "");
                }
            }
        }

        using (RegistryKey registered = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
            registered.SetValue(AppName, CapabilitiesKey);

        SHChangeNotify(SHCNE_ASSOCCHANGED, 0, IntPtr.Zero, IntPtr.Zero);

        if (openSettings) OpenDefaultAppsPage();
        return "PDF and Moore is registered. In the Settings page that opened, click each file type (.pdf, .docx, .xlsx, .pptx…) and choose PDF and Moore.";
    }

    /// <summary>Opens Settings › Default apps › PDF and Moore (or the Default apps list on older Windows).</summary>
    public static void OpenDefaultAppsPage()
    {
        try
        {
            Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=" + Uri.EscapeDataString(AppName)) { UseShellExecute = true });
        }
        catch
        {
            try { Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true }); } catch { }
        }
    }

    /// <summary>If the app was registered from an .exe that has since moved or been deleted, point Windows at this one.</summary>
    public static void RefreshIfMoved()
    {
        try
        {
            if (!IsRegistered) return;
            using RegistryKey? cmd = Registry.CurrentUser.OpenSubKey(@"Software\Classes\PdfAndMoore.Pdf\shell\open\command");
            string? current = cmd?.GetValue("") as string;
            string? registeredExe = current?.Split('"', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (registeredExe == null || !File.Exists(registeredExe)) Register(openSettings: false);
        }
        catch
        {
            // Never block start-up over this.
        }
    }

    /// <summary>Removes everything Register wrote (used by the uninstaller).</summary>
    public static void Unregister()
    {
        string exeName = Path.GetFileName(Environment.ProcessPath ?? "PDF and Moore.exe");
        using (RegistryKey? classes = Registry.CurrentUser.OpenSubKey(@"Software\Classes", writable: true))
        {
            if (classes != null)
            {
                foreach (var (progId, _, extensions) in Groups)
                {
                    classes.DeleteSubKeyTree(progId, throwOnMissingSubKey: false);
                    foreach (string ext in extensions)
                    {
                        using RegistryKey? owp = classes.OpenSubKey(ext + @"\OpenWithProgids", writable: true);
                        owp?.DeleteValue(progId, throwOnMissingValue: false);
                    }
                }
                classes.DeleteSubKeyTree(@"Applications\" + exeName, throwOnMissingSubKey: false);
            }
        }
        Registry.CurrentUser.DeleteSubKeyTree(CapabilitiesKey, throwOnMissingSubKey: false);
        using (RegistryKey? registered = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true))
            registered?.DeleteValue(AppName, throwOnMissingValue: false);
        SHChangeNotify(SHCNE_ASSOCCHANGED, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
