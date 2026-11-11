using Microsoft.Web.WebView2.Core;

namespace PdfAndMoore.Services;

/// <summary>
/// One shared Edge WebView2 environment for every window in the app (PDF editor, Office editors, Claude),
/// so the Claude sign-in is remembered in one place on this PC.
/// </summary>
public static class WebViewEnv
{
    private static Task<CoreWebView2Environment>? _env;

    public static string DataFolder => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PdfAndMoore", "WebView2");

    public static Task<CoreWebView2Environment> GetAsync() =>
        _env ??= CoreWebView2Environment.CreateAsync(null, DataFolder);
}
