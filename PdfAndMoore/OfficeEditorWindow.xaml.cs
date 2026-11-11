using System.ComponentModel;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using PdfAndMoore.Services;

namespace PdfAndMoore;

/// <summary>
/// A window that edits one Word document, Excel workbook or PowerPoint presentation with the
/// built-in editors (web pages in wwwroot\office, shown by Edge WebView2). Everything stays on this PC.
/// Before a file is overwritten the first time, the original is copied to %LOCALAPPDATA%\PdfAndMoore\Backups.
/// </summary>
public partial class OfficeEditorWindow : Window
{
    private const string AppHost = "app.pdfandmoore";
    private const string AppName = "PDF and Moore";

    private readonly string _kind;     // "word", "sheet" or "slides"
    private string? _path;             // null for a new, unsaved file
    private CoreWebView2? _core;
    private bool _dirty;
    private bool _closeAfterSave;
    private bool _forceClose;
    private readonly HashSet<string> _backedUp = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Open a file (or pass path = null for a new blank one).</summary>
    public OfficeEditorWindow(string? path, string kind)
    {
        _path = path;
        _kind = OfficeTypes.IsKind(kind) ? kind : "word";
        InitializeComponent();
        Title = (path != null ? Path.GetFileName(path) : "New " + OfficeTypes.Label(_kind)) + " - " + AppName;
        SplashText.Text = path != null ? "Opening " + Path.GetFileName(path) + "…" : "Starting…";
        Loaded += async (_, _) => await StartAsync();
        Closing += OnClosing;
    }

    private async Task StartAsync()
    {
        try
        {
            CoreWebView2Environment env = await WebViewEnv.GetAsync();
            await Web.EnsureCoreWebView2Async(env);
            _core = Web.CoreWebView2;
            string webRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            _core.SetVirtualHostNameToFolderMapping(AppHost, webRoot, CoreWebView2HostResourceAccessKind.Allow);
            _core.Settings.IsStatusBarEnabled = false;
            _core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no F5 reload losing work; Ctrl+S/P are handled by the page
            _core.Settings.IsZoomControlEnabled = false;
#if DEBUG
            _core.Settings.AreDevToolsEnabled = true;
#else
            _core.Settings.AreDevToolsEnabled = false;
#endif
            _core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                HostBridge.OpenInBrowser(args.Uri);
            };
            _core.NavigationStarting += (_, args) =>
            {
                // Links inside a document open in the normal web browser, not in this window.
                if (!args.Uri.StartsWith($"https://{AppHost}/", StringComparison.OrdinalIgnoreCase))
                {
                    args.Cancel = true;
                    HostBridge.OpenInBrowser(args.Uri);
                }
            };
            _core.WebMessageReceived += async (_, args) => await HandleAsync(args.TryGetWebMessageAsString());
            _core.NavigationCompleted += (_, args) =>
            {
                Splash.Visibility = Visibility.Collapsed;
                Web.Visibility = Visibility.Visible;
                if (!args.IsSuccess)
                    MessageBox.Show(this, "The editor did not load (" + args.WebErrorStatus + ").", AppName, MessageBoxButton.OK, MessageBoxImage.Error);
            };
            _core.Navigate($"https://{AppHost}/office/{_kind}.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this,
                "PDF and Moore needs the Microsoft Edge WebView2 Runtime, which comes with Windows 10 and 11.\n\n" +
                "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start the app again.",
                AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            _forceClose = true;
            Close();
        }
        catch (Exception ex)
        {
            SplashText.Text = "Could not start: " + ex.Message;
        }
    }

    // =====================================================================
    //  Messages from the editor page: { id, cmd, args } -> { type: "reply", id, ok, result | error }
    // =====================================================================

    private async Task HandleAsync(string message)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(message);
            JsonElement root = doc.RootElement;
            id = root.GetProperty("id").GetInt32();
            string cmd = root.GetProperty("cmd").GetString() ?? "";
            JsonElement args = root.TryGetProperty("args", out var a) ? a.Clone() : default;
            object? result = await RunAsync(cmd, args);
            Post(new { type = "reply", id, ok = true, result, error = (string?)null });
        }
        catch (Exception ex)
        {
            Post(new { type = "reply", id, ok = false, result = (object?)null, error = ex.Message });
        }
    }

    private void Post(object value) => _core?.PostWebMessageAsJson(MainWindow.ToJson(value));

    private void SendEvent(string name, object? data) => Post(new { type = "event", name, data });

    private async Task<object?> RunAsync(string cmd, JsonElement args)
    {
        switch (cmd)
        {
            case "ready":
            {
                if (_path == null || !File.Exists(_path)) return new { name = (string?)null, path = (string?)null, base64 = (string?)null };
                byte[] bytes = await ReadSharedAsync(_path);
                return new { name = Path.GetFileName(_path), path = _path, base64 = Convert.ToBase64String(bytes) };
            }

            case "save":
                return await SaveAsync(Convert.FromBase64String(Str(args, "base64") ?? ""), Str(args, "ext") ?? "docx",
                    Bool(args, "saveAs"), Str(args, "name"));

            case "setState":
            {
                _dirty = Bool(args, "dirty");
                string? title = Str(args, "title");
                if (!string.IsNullOrWhiteSpace(title)) Title = title;
                if (!_dirty && _closeAfterSave)
                {
                    _closeAfterSave = false;
                    _forceClose = true;
                    Close();
                }
                return true;
            }

            case "cancelClose":
                _closeAfterSave = false;
                return true;

            case "print":
                _core?.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
                return true;

            case "openAsPdf":
                if (_path == null) throw new InvalidOperationException("Save the file first.");
                MainWindow.OpenAsPdf(_path);
                return true;

            case "openExternal":
                HostBridge.OpenInBrowser(Str(args, "url") ?? "");
                return true;

            default:
                throw new NotSupportedException("Unknown command: " + cmd);
        }
    }

    // =====================================================================
    //  Saving
    // =====================================================================

    private async Task<object?> SaveAsync(byte[] bytes, string ext, bool saveAs, string? suggestedName)
    {
        ext = ext.TrimStart('.').ToLowerInvariant();
        if (bytes.Length == 0) throw new InvalidOperationException("The editor produced an empty file.");

        // Save straight back to the same file when it already has this format; otherwise ask where.
        string? target = _path;
        bool sameFormat = target != null && string.Equals(Path.GetExtension(target).TrimStart('.'), ext, StringComparison.OrdinalIgnoreCase);
        if (saveAs || target == null || !sameFormat)
        {
            string stem = target != null ? Path.GetFileNameWithoutExtension(target)
                : !string.IsNullOrWhiteSpace(suggestedName) ? Path.GetFileNameWithoutExtension(suggestedName) : "Untitled";
            var dialog = new SaveFileDialog
            {
                Title = saveAs ? "Save as" : "Save",
                FileName = stem + "." + ext,
                DefaultExt = ext,
                AddExtension = true,
                OverwritePrompt = true,
                Filter = OfficeTypes.SaveFilterFor(ext),
                InitialDirectory = target != null ? Path.GetDirectoryName(target) ?? "" : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            };
            if (dialog.ShowDialog(this) != true) return null;
            target = dialog.FileName;
        }

        BackupOnce(target!);
        // Write next to the file first, then swap it in, so a failed save never damages the original.
        string temp = target + ".saving";
        await File.WriteAllBytesAsync(temp, bytes);
        File.Move(temp, target!, overwrite: true);

        _path = target;
        return new { path = target, name = Path.GetFileName(target) };
    }

    /// <summary>The first time an existing file is overwritten from this window, keep a copy of the original.</summary>
    private void BackupOnce(string target)
    {
        try
        {
            if (!File.Exists(target) || !_backedUp.Add(target)) return;
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PdfAndMoore", "Backups");
            Directory.CreateDirectory(dir);
            File.Copy(target, Path.Combine(dir, $"{DateTime.Now:yyyy-MM-dd HHmmss} {Path.GetFileName(target)}"), overwrite: true);
        }
        catch
        {
            // A backup problem should never stop the save itself.
        }
    }

    private static async Task<byte[]> ReadSharedAsync(string path)
    {
        await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var ms = new MemoryStream();
        await fs.CopyToAsync(ms);
        return ms.ToArray();
    }

    // =====================================================================
    //  Closing: ask about unsaved changes, like Word does
    // =====================================================================

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_forceClose || !_dirty || _core == null) return;
        var answer = MessageBox.Show(this, $"Do you want to save your changes to \"{(_path != null ? Path.GetFileName(_path) : "this " + OfficeTypes.Label(_kind))}\"?",
            AppName, MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
        if (answer == MessageBoxResult.Cancel)
        {
            e.Cancel = true;
        }
        else if (answer == MessageBoxResult.Yes)
        {
            e.Cancel = true;
            _closeAfterSave = true;
            SendEvent("saveBeforeClose", null);
        }
    }

    // ------------------------------------------------------------------
    private static string? Str(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
