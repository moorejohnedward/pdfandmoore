using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using PdfAndMoore.Services;

namespace PdfAndMoore;

/// <summary>
/// The main window. It hosts the editor (a web page in Edge WebView2) and connects it
/// to Windows: file dialogs, saving, settings, the Claude API and Word/Excel-to-PDF printing.
/// </summary>
public partial class MainWindow : Window
{
    private const string AppHost = "app.pdfandmoore";
    private const string AppName = "PDF and Moore";

    private readonly string? _startupFile;
    private readonly bool _startupAsPdf;
    private HostBridge? _bridge;
    private CoreWebView2Environment? _env;
    private ClaudeWebWindow? _claudeWindow;
    private bool _dirty;
    private bool _closeAfterSave;
    private bool _forceClose;

    public MainWindow(string? startupFile = null, bool startupAsPdf = false)
    {
        _startupFile = startupFile;
        _startupAsPdf = startupAsPdf;
        InitializeComponent();
        ApplyTheme(UiPrefs.Load().Theme);
        Loaded += async (_, _) => await InitializeEditorAsync();
        Closing += OnClosing;
    }

    /// <summary>Starts WebView2, maps the editor's files to a private address, and loads it.</summary>
    private async Task InitializeEditorAsync()
    {
        try
        {
            // One shared WebView2 environment for all windows (editor, Office editors, Claude).
            var env = await WebViewEnv.GetAsync();
            _env = env;
            await Web.EnsureCoreWebView2Async(env);
            await PrintView.EnsureCoreWebView2Async(env);

            CoreWebView2 core = Web.CoreWebView2;
            string webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            core.SetVirtualHostNameToFolderMapping(AppHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);

            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false; // keeps F5 / Ctrl+R from reloading and losing work
            core.Settings.IsZoomControlEnabled = false;             // Ctrl+wheel zooms the PDF, not the window
#if DEBUG
            core.Settings.AreDevToolsEnabled = true;
#else
            core.Settings.AreDevToolsEnabled = false;
#endif
            // Links that would open a new window go to the normal web browser instead.
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                HostBridge.OpenInBrowser(args.Uri);
            };

            _bridge = new HostBridge(this, core, new HtmlToPdfService(PrintView.CoreWebView2));
            core.WebMessageReceived += async (_, args) => await _bridge.HandleAsync(args.TryGetWebMessageAsString());
            core.NavigationCompleted += (_, args) =>
            {
                Splash.Visibility = Visibility.Collapsed;
                Web.Visibility = Visibility.Visible;
                if (!args.IsSuccess)
                {
                    MessageBox.Show(this, "The editor did not load (" + args.WebErrorStatus + ").", AppName,
                        MessageBoxButton.OK, MessageBoxImage.Error);
                }
            };

            core.Navigate($"https://{AppHost}/index.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "PDF and Moore needs the Microsoft Edge WebView2 Runtime, which comes with Windows 10 and 11.\n\n" +
                "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start the app again.",
                AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            Close();
        }
        catch (Exception ex)
        {
            SplashStatus.Text = "Could not start: " + ex.Message;
        }
    }

    /// <summary>Called by the bridge when the editor is ready for messages.</summary>
    internal void OnEditorReady()
    {
        _ = CheckForUpdateQuietlyAsync();
        if (_startupFile != null)
        {
            if (!_startupAsPdf && OfficeTypes.EditorFor(_startupFile) != null) OpenInEditor(_startupFile);
            else _bridge?.SendEvent(_startupAsPdf ? "openPathAsPdf" : "openPath", _startupFile);
        }
    }

    private static bool _updateChecked;

    /// <summary>Once per run, look for a newer version in the background and mention it in the editor.</summary>
    private async Task CheckForUpdateQuietlyAsync()
    {
        if (_updateChecked || !UpdateService.CheckOnStartup) return;
        _updateChecked = true;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(4)); // let the editor settle first
            var info = await UpdateService.CheckAsync();
            if (info == null || UpdateService.IsSkipped(info)) return;
            _bridge?.SendEvent("updateAvailable", new { version = info.Version.ToString(3) });
        }
        catch { } // offline: try again next time
    }

    /// <summary>Tools › Check for updates…</summary>
    internal void ShowUpdates()
    {
        var open = Application.Current.Windows.OfType<UpdateWindow>().FirstOrDefault();
        if (open != null) { open.Activate(); return; }
        new UpdateWindow { Owner = this }.Show();
    }

    /// <summary>Edit a Word, Excel or PowerPoint file in the built-in editor (its own window).</summary>
    internal static void OpenInEditor(string path)
    {
        string? kind = OfficeTypes.EditorFor(path);
        if (kind == null) throw new NotSupportedException("The built-in editors can't open this kind of file.");
        new OfficeEditorWindow(path, kind).Show();
    }

    /// <summary>Start a new blank document, spreadsheet or presentation.</summary>
    internal static void NewOfficeFile(string kind)
    {
        new OfficeEditorWindow(null, kind).Show();
    }

    /// <summary>Open a file in the PDF editor (turning Word/Excel/PowerPoint into PDF pages).</summary>
    internal static void OpenAsPdf(string path)
    {
        MainWindow? main = Application.Current.Windows.OfType<MainWindow>().FirstOrDefault(w => w.IsVisible);
        if (main?._bridge != null)
        {
            main._bridge.SendEvent("openPathAsPdf", path);
            if (main.WindowState == WindowState.Minimized) main.WindowState = WindowState.Normal;
            main.Activate();
        }
        else
        {
            new MainWindow(path, startupAsPdf: true).Show();
        }
    }

    /// <summary>The editor reports unsaved changes and the window title.</summary>
    internal void SetDocumentState(bool dirty, string? title)
    {
        _dirty = dirty;
        if (!string.IsNullOrWhiteSpace(title)) Title = title;
        if (!dirty && _closeAfterSave)
        {
            _closeAfterSave = false;
            _forceClose = true;
            Close();
        }
    }

    /// <summary>Show the claude.ai window (where people sign in with their own Claude account).</summary>
    internal void ShowClaudeWindow(string? hint)
    {
        if (_env == null) return;
        _claudeWindow ??= new ClaudeWebWindow(_env);
        _claudeWindow.ShowBeside(this, hint);
    }

    /// <summary>The save before closing was cancelled, so keep the window open.</summary>
    internal void CancelPendingClose() => _closeAfterSave = false;

    /// <summary>Ask about unsaved changes before closing, like Word does.</summary>
    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_forceClose || !_dirty || _bridge == null)
        {
            CloseClaudeWindow();
            return;
        }
        var answer = MessageBox.Show(this, "Do you want to save your changes before closing?", AppName,
            MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
        if (answer == MessageBoxResult.Cancel)
        {
            e.Cancel = true;
        }
        else if (answer == MessageBoxResult.Yes)
        {
            e.Cancel = true;
            _closeAfterSave = true;
            _bridge.SendEvent("saveBeforeClose", null);
        }
        else
        {
            CloseClaudeWindow();
        }
    }

    private void CloseClaudeWindow()
    {
        if (_claudeWindow == null) return;
        _claudeWindow.AppIsClosing = true;
        _claudeWindow.Close();
    }

    /// <summary>Colors the Windows parts of the window (behind the editor and the start-up splash) to match the theme.</summary>
    internal void ApplyTheme(string theme)
    {
        bool dark = !string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase);
        var bg = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(dark ? "#0F1B2D" : "#F9FBFD");
        Background = new System.Windows.Media.SolidColorBrush(bg);
        var fg = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(dark ? "#EAF1F8" : "#1F1F1F");
        SplashTitle.Foreground = new System.Windows.Media.SolidColorBrush(fg);
        Web.DefaultBackgroundColor = dark ? System.Drawing.Color.FromArgb(0x0F, 0x1B, 0x2D) : System.Drawing.Color.FromArgb(0xF9, 0xFB, 0xFD);
    }

    internal static string ToJson(object? value) => JsonSerializer.Serialize(value, HostBridge.JsonOptions);
}
