using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Web.WebView2.Core;
using System.Windows;
using Microsoft.Win32;

namespace PdfAndMoore.Services;

/// <summary>
/// Receives requests from the editor (JavaScript) and answers them.
/// Every request looks like { id, cmd, args } and gets a reply { type: "reply", id, ok, result | error }.
/// </summary>
public sealed class HostBridge
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    private readonly MainWindow _window;
    private readonly CoreWebView2 _web;
    private readonly HtmlToPdfService _htmlToPdf;
    private readonly SettingsStore _settings = new();
    private readonly RecentFiles _recent = new();
    private readonly ClaudeClient _claude = new();

    private const string OpenFilter =
        "All supported files|*.pdf;*.docx;*.doc;*.docm;*.dotx;*.dot;*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods;*.odp;*.pptx;*.ppt;*.pptm;*.ppsx;*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.heif;*.avif;*.txt;*.md;*.html;*.htm;*.rtf;*.odt;*.json;*.xml|" +
        "PDF files (*.pdf)|*.pdf|" +
        "Word documents (*.docx, *.doc, *.rtf, *.odt)|*.docx;*.doc;*.docm;*.dotx;*.dot;*.rtf;*.odt|" +
        "Excel workbooks (*.xlsx, *.xls, *.csv)|*.xlsx;*.xlsm;*.xls;*.xlsb;*.csv;*.tsv;*.ods|" +
        "PowerPoint (*.pptx, *.ppt)|*.pptx;*.ppt;*.pptm;*.ppsx;*.odp|" +
        "Pictures and scans|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.heif;*.avif|" +
        "Text and web pages|*.txt;*.md;*.html;*.htm;*.rtf;*.json;*.xml|" +
        "All files (*.*)|*.*";

    public HostBridge(MainWindow window, CoreWebView2 web, HtmlToPdfService htmlToPdf)
    {
        _window = window;
        _web = web;
        _htmlToPdf = htmlToPdf;
    }

    /// <summary>Send an event the editor did not ask for (e.g. "open this file").</summary>
    public void SendEvent(string name, object? data)
    {
        _web.PostWebMessageAsJson(MainWindow.ToJson(new { type = "event", name, data }));
    }

    public async Task HandleAsync(string message)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(message);
            JsonElement root = doc.RootElement;
            id = root.GetProperty("id").GetInt32();
            string cmd = root.GetProperty("cmd").GetString() ?? "";
            JsonElement args = root.TryGetProperty("args", out var a) ? a.Clone() : default;
            object? result = await RunAsync(id, cmd, args);
            Reply(id, true, result, null);
        }
        catch (Exception ex)
        {
            Reply(id, false, null, ex.Message);
        }
    }

    private void Reply(int id, bool ok, object? result, string? error)
    {
        _web.PostWebMessageAsJson(MainWindow.ToJson(new { type = "reply", id, ok, result, error }));
    }

    private async Task<object?> RunAsync(int id, string cmd, JsonElement args)
    {
        switch (cmd)
        {
            case "ready":
                _window.OnEditorReady();
                return true;

            case "openFiles":
                return OpenFiles(Bool(args, "multiple"), Str(args, "filter") ?? "all");

            case "readPath":
            {
                string path = Str(args, "path") ?? throw new ArgumentException("No file path given.");
                byte[] bytes = await File.ReadAllBytesAsync(path);
                if (path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) _recent.Add(path);
                return new { name = Path.GetFileName(path), path, base64 = Convert.ToBase64String(bytes) };
            }

            case "saveFile":
                return await SaveFileAsync(
                    Str(args, "name") ?? "Untitled.pdf",
                    Str(args, "path"),
                    Bool(args, "saveAs"),
                    Str(args, "base64") ?? "");

            case "htmlToPdf":
            {
                byte[] pdf = await _htmlToPdf.ConvertAsync(Str(args, "html") ?? "", Bool(args, "landscape"));
                return Convert.ToBase64String(pdf);
            }

            case "getSettings":
                return _settings.Load();

            case "saveSettings":
                _settings.Save(new AppSettings
                {
                    ApiKey = Str(args, "apiKey") ?? "",
                    Model = Str(args, "model") ?? "claude-sonnet-5-5",
                    UserName = Str(args, "userName") ?? "",
                    ClaudeMode = Str(args, "claudeMode") ?? "",
                    ClaudeWhere = Str(args, "claudeWhere") ?? "app",
                    LocalModel = Str(args, "localModel") ?? "",
                });
                return true;

            case "openClaudeWeb":
                OpenClaude(Str(args, "hint"));
                return true;

            case "sendToClaudeWeb":
            {
                // Put the text or picture on the clipboard, then bring Claude up so it can be pasted.
                string? text = Str(args, "text");
                string? image = Str(args, "imageBase64");
                if (!string.IsNullOrEmpty(image)) ClipboardHelper.SetPng(Convert.FromBase64String(image));
                else ClipboardHelper.SetText(text ?? "");
                OpenClaude(Str(args, "hint"));
                return true;
            }

            case "getRecent":
                return _recent.Load();

            case "setState":
                _window.SetDocumentState(Bool(args, "dirty"), Str(args, "title"));
                return true;

            case "cancelClose":
                _window.CancelPendingClose();
                return true;

            case "openExternal":
                OpenInBrowser(Str(args, "url") ?? "");
                return true;

            case "claude":
            {
                AppSettings s = _settings.Load();
                if (string.IsNullOrWhiteSpace(s.ApiKey))
                    throw new InvalidOperationException("Add your Claude API key in Settings first.");
                string body = Str(args, "body") ?? "{}";
                // Stream each piece of the reply to the editor as it arrives.
                return await _claude.StreamAsync(body, s.ApiKey, text =>
                    _web.PostWebMessageAsJson(MainWindow.ToJson(new { type = "stream", id, text })));
            }

            // ---- Digital IDs (certificate signatures) ----
            case "listDigitalIds":
                return DigitalIdService.List();

            case "createDigitalId":
                return DigitalIdService.Create(Str(args, "name") ?? "", Str(args, "email"), Str(args, "org"));

            case "importDigitalId":
            {
                var dialog = new OpenFileDialog
                {
                    Title = "Import a digital ID",
                    Filter = "Digital ID (*.pfx, *.p12)|*.pfx;*.p12|All files (*.*)|*.*",
                };
                if (dialog.ShowDialog(_window) != true) return null;
                return DigitalIdService.Import(dialog.FileName, Str(args, "password") ?? "");
            }

            case "exportDigitalId":
            {
                byte[] pfx = DigitalIdService.Export(Str(args, "thumbprint") ?? "", Str(args, "password") ?? "");
                var dialog = new SaveFileDialog
                {
                    Title = "Back up your digital ID",
                    FileName = "My digital ID.pfx",
                    DefaultExt = "pfx",
                    Filter = "Digital ID (*.pfx)|*.pfx",
                    OverwritePrompt = true,
                };
                if (dialog.ShowDialog(_window) != true) return null;
                await File.WriteAllBytesAsync(dialog.FileName, pfx);
                return dialog.FileName;
            }

            case "signCms":
            {
                byte[] data = Convert.FromBase64String(Str(args, "dataBase64") ?? "");
                return Convert.ToBase64String(DigitalIdService.Sign(Str(args, "thumbprint") ?? "", data));
            }

            // ---- Built-in Word / Excel / PowerPoint editors ----
            case "editOffice":
            {
                string path = Str(args, "path") ?? throw new ArgumentException("No file path given.");
                MainWindow.OpenInEditor(path);
                return true;
            }

            case "openOffice":
            {
                var dialog = new OpenFileDialog
                {
                    Title = "Open a Word, Excel or PowerPoint file",
                    Multiselect = true,
                    Filter = OfficeTypes.OpenFilter,
                };
                if (dialog.ShowDialog(_window) != true) return null;
                foreach (string path in dialog.FileNames)
                {
                    if (OfficeTypes.EditorFor(path) != null) MainWindow.OpenInEditor(path);
                }
                return null;
            }

            case "newOffice":
            {
                string kind = Str(args, "kind") ?? "word";
                if (!OfficeTypes.IsKind(kind)) throw new ArgumentException("Unknown kind of file: " + kind);
                MainWindow.NewOfficeFile(kind);
                return null;
            }

            case "setDefaultApp":
                return FileAssociations.Register(openSettings: true);

            case "checkUpdates":
                _window.ShowUpdates();
                return null;

            case "appVersion":
                return UpdateService.CurrentVersion.ToString(3);

            default:
                throw new NotSupportedException("Unknown command: " + cmd);
        }
    }

    private void OpenClaude(string? hint)
    {
        if (_settings.Load().ClaudeWhere == "browser") OpenInBrowser("https://claude.ai/new");
        else _window.ShowClaudeWindow(hint);
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------
    private object[] OpenFiles(bool multiple, string filter)
    {
        var dialog = new OpenFileDialog
        {
            Title = multiple ? "Open files" : "Open a file",
            Multiselect = multiple,
            Filter = filter switch
            {
                "pdf" => "PDF files (*.pdf)|*.pdf",
                "image" => "Pictures|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.heif|All files (*.*)|*.*",
                _ => OpenFilter,
            },
        };
        if (dialog.ShowDialog(_window) != true) return Array.Empty<object>();

        var files = new List<object>();
        foreach (string path in dialog.FileNames)
        {
            byte[] bytes = File.ReadAllBytes(path);
            if (path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) _recent.Add(path);
            files.Add(new { name = Path.GetFileName(path), path, base64 = Convert.ToBase64String(bytes) });
        }
        return files.ToArray();
    }

    private async Task<string?> SaveFileAsync(string name, string? path, bool saveAs, string base64)
    {
        byte[] bytes = Convert.FromBase64String(base64);
        string? target = path;

        if (saveAs || string.IsNullOrEmpty(target))
        {
            string ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            var dialog = new SaveFileDialog
            {
                Title = "Save",
                FileName = name,
                DefaultExt = ext,
                AddExtension = true,
                OverwritePrompt = true,
                Filter = FilterFor(ext),
            };
            if (!string.IsNullOrEmpty(path))
            {
                dialog.InitialDirectory = Path.GetDirectoryName(path);
            }
            if (dialog.ShowDialog(_window) != true) return null;
            target = dialog.FileName;
        }

        // Write to a temporary file first, then swap it in, so a failed save never damages the original.
        string temp = target + ".saving";
        await File.WriteAllBytesAsync(temp, bytes);
        File.Move(temp, target!, overwrite: true);

        if (target!.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) _recent.Add(target);
        return target;
    }

    private static string FilterFor(string ext) => ext switch
    {
        "pdf" => "PDF file (*.pdf)|*.pdf",
        "docx" => "Word document (*.docx)|*.docx",
        "xlsx" => "Excel workbook (*.xlsx)|*.xlsx",
        "png" => "PNG image (*.png)|*.png",
        "jpg" => "JPEG image (*.jpg)|*.jpg",
        "txt" => "Text file (*.txt)|*.txt",
        "html" => "Web page (*.html)|*.html",
        "zip" => "Zip file (*.zip)|*.zip",
        _ => "All files (*.*)|*.*",
    };

    public static void OpenInBrowser(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeMailto) return;
        Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
    }

    // ------------------------------------------------------------------
    // Small JSON helpers
    // ------------------------------------------------------------------
    private static string? Str(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static bool Bool(JsonElement args, string name) =>
        args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
