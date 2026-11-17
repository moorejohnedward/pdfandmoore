using System.Windows;
using System.Windows.Threading;
using PdfAndMoore.Services;

namespace PdfAndMoore;

/// <summary>
/// Application entry point. A file path passed on the command line
/// (for example from "Open with" or double-clicking in File Explorer) is opened at start-up:
/// PDFs, pictures and other files in the PDF editor; Word, Excel and PowerPoint files in the built-in editors.
/// "--register-defaults" / "--unregister" are used by the installer.
/// </summary>
public partial class App : Application
{
    private void OnStartup(object sender, StartupEventArgs e)
    {
        if (e.Args.Any(a => a.Equals("--register-defaults", StringComparison.OrdinalIgnoreCase)))
        {
            try { FileAssociations.Register(openSettings: true); } catch { }
            Shutdown();
            return;
        }
        if (e.Args.Any(a => a.Equals("--unregister", StringComparison.OrdinalIgnoreCase)))
        {
            try { FileAssociations.Unregister(); } catch { }
            Shutdown();
            return;
        }

        UpdateService.CleanupAfterUpdate();
        FileAssociations.RefreshIfMoved();
        AppLinks.Register();

        // v9.9 Profiles: decide who is using the app before anything reads settings or starts WebView2.
        // Until a window is open, closing "Who's using?" must not be mistaken for the app ending early.
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        if (!SignInAtStartup(e.Args))
        {
            Shutdown();
            return;
        }
        Profiles.SignOutRequested += () => Dispatcher.BeginInvoke(() => SignOut(relaunch: false));
        OpenStartupWindow(e.Args);
        ShutdownMode = ShutdownMode.OnLastWindowClose;
    }

    /// <summary>Opens the first window: a file passed on the command line, a new document, or the PDF editor.</summary>
    private static void OpenStartupWindow(string[] args)
    {
        Current.MainWindow = null; // "Who's using?" may have been the first window; let the real one take over
        // From KonaSnap (v9.8): "--new-from <file> [--as word|text]" opens a new, unsaved Word document or text file
        // filled with that text; "--read-text <picture>" reads the words in a picture with the deep reader.
        string? newFrom = ArgAfter(args, "--new-from");
        if (newFrom != null && File.Exists(newFrom))
        {
            string kind = ArgAfter(args, "--as") is { } k && OfficeTypes.IsKind(k) ? k : "text";
            new OfficeEditorWindow(null, kind, newFrom).Show();
            return;
        }
        string? readText = ArgAfter(args, "--read-text");
        if (readText != null && File.Exists(readText))
        {
            new MainWindow(null, false, readText).Show();
            return;
        }

        string? fileToOpen = args.FirstOrDefault(a => File.Exists(a));
        bool asPdf = args.Any(a => a.Equals("--pdf", StringComparison.OrdinalIgnoreCase));

        if (fileToOpen != null && !asPdf)
        {
            string? kind = OfficeTypes.EditorFor(fileToOpen);
            if (kind != null)
            {
                new OfficeEditorWindow(fileToOpen, kind).Show();
                return;
            }
        }

        // "--new word|sheet|slides" starts a blank document (used by shortcuts).
        int newIdx = Array.FindIndex(args, a => a.Equals("--new", StringComparison.OrdinalIgnoreCase));
        if (newIdx >= 0 && newIdx + 1 < args.Length && OfficeTypes.IsKind(args[newIdx + 1]))
        {
            new OfficeEditorWindow(null, args[newIdx + 1]).Show();
            return;
        }

        var window = new MainWindow(fileToOpen, asPdf);
        window.Show();
    }

    private static string? ArgAfter(string[] args, string name)
    {
        int i = Array.FindIndex(args, a => a.Equals(name, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    /// <summary>
    /// As the app closes: after "Sign out", tell any other open copies to close and come back to "Who's using?";
    /// otherwise just leave the session (other open copies stay signed in). After "Restart now" in the
    /// update window, start the new version.
    /// </summary>
    private void OnExit(object sender, ExitEventArgs e)
    {
        if (_signingOut && _relaunchAfterSignOut)
        {
            Profiles.EndSessionEverywhere();
            if (!UpdateService.RelaunchOnExit) StartCopy("--choose-profile");
        }
        else
        {
            Profiles.LeaveSession();
        }
        UpdateService.RelaunchIfRequested();
    }

    // =====================================================================
    //  v9.9 Profiles: signing in and out
    // =====================================================================

    private static bool _signingOut;
    private static bool _relaunchAfterSignOut;
    private static readonly HashSet<Window> _closingForSignOut = new();

    /// <summary>
    /// Picks who is using the app. Skips the question when only one person is set up with no PIN,
    /// or when someone is already signed in in another open copy (e.g. double-clicking a PDF).
    /// Returns false if "Who's using?" was closed without choosing.
    /// </summary>
    private static bool SignInAtStartup(string[] args)
    {
        bool afterSignOut = args.Any(a => a.Equals("--choose-profile", StringComparison.OrdinalIgnoreCase));
        ProfileList list = Profiles.Load();

        if (!afterSignOut && Profiles.LiveSessionProfileId() is { } liveId && Profiles.Find(list, liveId) is { } live)
        {
            Profiles.SignIn(list, live);
            return true;
        }

        bool ask = afterSignOut || list.AskEveryTime || list.Profiles.Count > 1 || list.Profiles.Any(p => p.HasPin);
        string? chosenId = list.Profiles[0].Id;
        if (ask)
        {
            var picker = new ProfilePickerWindow(afterSignOut ? "You're signed out." : null);
            if (picker.ShowDialog() != true || picker.Chosen == null) return false;
            chosenId = picker.Chosen.Id;
        }

        list = Profiles.Load(); // "Who's using?" may have added people or changed PINs
        Profile? chosen = Profiles.Find(list, chosenId);
        if (chosen == null) return false;
        Profiles.SignIn(list, chosen);
        return true;
    }

    /// <summary>
    /// Tools › Sign out (or switch person): closes every window (asking about unsaved changes, like Word),
    /// then shows "Who's using PDF and Moore?". relaunch = false when another copy of the app signed out.
    /// </summary>
    internal static void SignOut(bool relaunch = true)
    {
        if (_signingOut) return;
        _signingOut = true;
        _relaunchAfterSignOut = relaunch;
        var app = Current;

        var editors = app.Windows.OfType<Window>().Where(w => w is MainWindow || w is OfficeEditorWindow).ToList();
        if (editors.Count == 0)
        {
            app.Shutdown();
            return;
        }
        _closingForSignOut.Clear();
        foreach (var w in editors)
        {
            _closingForSignOut.Add(w);
            w.Closed += (_, _) =>
            {
                _closingForSignOut.Remove(w);
                if (_signingOut && _closingForSignOut.Count == 0) app.Shutdown(); // also closes the Claude window, updates, etc.
            };
        }
        foreach (var w in editors) w.Close();
    }

    /// <summary>Someone pressed Cancel on "Save your changes?", so stay signed in.</summary>
    internal static void CancelSignOut()
    {
        _signingOut = false;
        _closingForSignOut.Clear();
    }

    private static void StartCopy(string args)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(UpdateService.CurrentExePath, args) { UseShellExecute = false });
        }
        catch { }
    }

    private void OnUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        string log = CrashLog.Write(e.Exception);
        MessageBox.Show(
            "Something went wrong:\n\n" + e.Exception.Message +
            (log.Length > 0 ? "\n\nThe details were saved to " + log + " (paste them to Claude to get it fixed)." : ""),
            "PDF and Moore",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        e.Handled = true;
    }
}

/// <summary>Keeps a record of errors in %LOCALAPPDATA%\PdfAndMoore\crash.log so they can be fixed.</summary>
internal static class CrashLog
{
    public static string Write(Exception ex)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PdfAndMoore");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "crash.log");
            File.AppendAllText(file,
                $"PDF and Moore {UpdateService.CurrentVersion.ToString(3)}, {DateTime.Now:yyyy-MM-dd HH:mm:ss}, {Environment.OSVersion}\r\n" +
                ex + "\r\n" + new string('-', 60) + "\r\n");
            return file;
        }
        catch { return ""; }
    }
}
