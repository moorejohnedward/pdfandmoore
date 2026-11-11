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

        FileAssociations.RefreshIfMoved();

        string? fileToOpen = e.Args.FirstOrDefault(a => File.Exists(a));
        bool asPdf = e.Args.Any(a => a.Equals("--pdf", StringComparison.OrdinalIgnoreCase));

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
        int newIdx = Array.FindIndex(e.Args, a => a.Equals("--new", StringComparison.OrdinalIgnoreCase));
        if (newIdx >= 0 && newIdx + 1 < e.Args.Length && OfficeTypes.IsKind(e.Args[newIdx + 1]))
        {
            new OfficeEditorWindow(null, e.Args[newIdx + 1]).Show();
            return;
        }

        var window = new MainWindow(fileToOpen, asPdf);
        window.Show();
    }

    private void OnUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        MessageBox.Show(
            "Something went wrong:\n\n" + e.Exception.Message,
            "PDF and Moore",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        e.Handled = true;
    }
}
