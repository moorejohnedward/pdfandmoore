using Microsoft.Web.WebView2.Core;

namespace PdfAndMoore.Services;

/// <summary>
/// One shared Edge WebView2 environment for every window in the app (PDF editor, Office editors, Claude),
/// so the Claude sign-in is remembered in one place on this PC.
/// </summary>
public static class WebViewEnv
{
    private static Task<CoreWebView2Environment>? _env;

    /// <summary>v9.9: each person has their own WebView2 folder, so Claude sign-ins and saved signatures stay theirs.</summary>
    public static string DataFolder => Path.Combine(Profiles.LocalDir, "WebView2");

    public static Task<CoreWebView2Environment> GetAsync() =>
        _env ??= CoreWebView2Environment.CreateAsync(null, DataFolder);
}
