using System.Windows;
using Microsoft.Web.WebView2.Core;
using PdfAndMoore.Services;

namespace PdfAndMoore;

/// <summary>
/// A window showing claude.ai, so people can sign in with their own Claude account
/// (Free, Pro or Max) and use Claude next to their document.
/// The app never sees the password or sign-in; it only puts things on the clipboard
/// ("Send to Claude") for the person to paste into the chat.
/// </summary>
public partial class ClaudeWebWindow : Window
{
    private const string ClaudeHome = "https://claude.ai/new";
    private readonly CoreWebView2Environment _env;
    private bool _ready;

    public ClaudeWebWindow(CoreWebView2Environment env)
    {
        _env = env;
        InitializeComponent();
        Loaded += async (_, _) => await StartAsync();
    }

    private async Task StartAsync()
    {
        await Web.EnsureCoreWebView2Async(_env);
        CoreWebView2 core = Web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;

        // Sign-in pop-ups (Google, email links) stay in this window; anything else opens in the normal browser.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (IsSignInOrClaude(args.Uri)) core.Navigate(args.Uri);
            else HostBridge.OpenInBrowser(args.Uri);
        };
        core.NavigationStarting += (_, args) =>
        {
            if (!IsSignInOrClaude(args.Uri))
            {
                args.Cancel = true;
                HostBridge.OpenInBrowser(args.Uri);
            }
        };
        core.Navigate(ClaudeHome);
        _ready = true;
    }

    private static bool IsSignInOrClaude(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)) return false;
        string host = uri.Host.ToLowerInvariant();
        string[] allowed = { "claude.ai", "claude.com", "anthropic.com", "accounts.google.com", "appleid.apple.com" };
        return allowed.Any(a => host == a || host.EndsWith("." + a));
    }

    /// <summary>Bring the window up beside the main window.</summary>
    public void ShowBeside(Window owner, string? hint)
    {
        if (!IsVisible)
        {
            Height = Math.Max(500, owner.ActualHeight);
            Top = owner.Top;
            double right = owner.Left + owner.ActualWidth;
            Left = right + Width <= SystemParameters.VirtualScreenWidth ? right - 8 : Math.Max(0, right - Width);
            Show();
        }
        if (!string.IsNullOrWhiteSpace(hint)) HintText.Text = hint;
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Web.Focus();
    }

    private void OnBack(object sender, RoutedEventArgs e)
    {
        if (_ready && Web.CoreWebView2.CanGoBack) Web.CoreWebView2.GoBack();
    }

    private void OnNewChat(object sender, RoutedEventArgs e)
    {
        if (_ready) Web.CoreWebView2.Navigate(ClaudeHome);
    }

    private void OnOpenInBrowser(object sender, RoutedEventArgs e) => HostBridge.OpenInBrowser(ClaudeHome);

    /// <summary>Closing just hides the window so the conversation is still there next time.</summary>
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!AppIsClosing)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    public bool AppIsClosing { get; set; }
}
