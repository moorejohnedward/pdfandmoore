using Microsoft.Web.WebView2.Core;

namespace PdfAndMoore.Services;

/// <summary>
/// Turns HTML (made from Word, Excel, PowerPoint or text files) into PDF pages
/// using a hidden Edge WebView2 and its built-in "Print to PDF".
/// </summary>
public sealed class HtmlToPdfService
{
    private const string PrintHost = "print.pdfandmoore";
    private readonly CoreWebView2 _view;
    private readonly string _folder;
    private readonly SemaphoreSlim _oneAtATime = new(1, 1);

    public HtmlToPdfService(CoreWebView2 view)
    {
        _view = view;
        _folder = Path.Combine(Path.GetTempPath(), "PdfAndMoore", "print");
        Directory.CreateDirectory(_folder);
        // Serve the temp folder at a private address (NavigateToString is limited to 2 MB).
        _view.SetVirtualHostNameToFolderMapping(PrintHost, _folder, CoreWebView2HostResourceAccessKind.Allow);
    }

    public async Task<byte[]> ConvertAsync(string html, bool landscape)
    {
        await _oneAtATime.WaitAsync();
        string fileName = Guid.NewGuid().ToString("N") + ".html";
        string filePath = Path.Combine(_folder, fileName);
        try
        {
            await File.WriteAllTextAsync(filePath, html);

            var loaded = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            void OnDone(object? s, CoreWebView2NavigationCompletedEventArgs e) => loaded.TrySetResult(e.IsSuccess);
            _view.NavigationCompleted += OnDone;
            try
            {
                _view.Navigate($"https://{PrintHost}/{fileName}");
                Task finished = await Task.WhenAny(loaded.Task, Task.Delay(TimeSpan.FromSeconds(30)));
                if (finished != loaded.Task || !loaded.Task.Result)
                    throw new InvalidOperationException("The document could not be prepared for conversion.");
            }
            finally
            {
                _view.NavigationCompleted -= OnDone;
            }

            CoreWebView2PrintSettings settings = _view.Environment.CreatePrintSettings();
            settings.Orientation = landscape ? CoreWebView2PrintOrientation.Landscape : CoreWebView2PrintOrientation.Portrait;
            settings.PageWidth = 8.5;
            settings.PageHeight = 11;
            settings.MarginTop = 0.5;
            settings.MarginBottom = 0.5;
            settings.MarginLeft = 0.5;
            settings.MarginRight = 0.5;
            settings.ShouldPrintBackgrounds = true;
            settings.ShouldPrintHeaderAndFooter = false;

            using Stream pdf = await _view.PrintToPdfStreamAsync(settings);
            using var memory = new MemoryStream();
            await pdf.CopyToAsync(memory);
            return memory.ToArray();
        }
        finally
        {
            try { File.Delete(filePath); } catch (IOException) { }
            _oneAtATime.Release();
        }
    }
}
