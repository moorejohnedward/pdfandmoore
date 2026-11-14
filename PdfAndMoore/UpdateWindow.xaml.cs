using System.Windows;
using PdfAndMoore.Services;

namespace PdfAndMoore;

/// <summary>Tools › Check for updates…: shows what's new, then downloads, verifies and installs it.</summary>
public partial class UpdateWindow : Window
{
    private UpdateInfo? _info;
    private bool _installing;
    private bool _done;

    public UpdateWindow(UpdateInfo? found = null)
    {
        InitializeComponent();
        ApplyLook();
        AutoCheckBox.IsChecked = UpdateService.CheckOnStartup;
        AutoCheckBox.Checked += (_, _) => UpdateService.CheckOnStartup = true;
        AutoCheckBox.Unchecked += (_, _) => UpdateService.CheckOnStartup = false;
        Closing += (_, e) => { if (_installing) e.Cancel = true; };

        if (UpdateService.Installed)
        {
            ShowInstalled();
            return;
        }
        if (found != null) ShowRelease(found);
        else Loaded += async (_, _) => await RunCheckAsync();
    }

    private async Task RunCheckAsync()
    {
        HeadlineText.Text = "Checking for updates…";
        VersionText.Text = $"You have PDF and Moore {UpdateService.CurrentVersion.ToString(3)}.";
        UpdateButton.Visibility = SkipButton.Visibility = Visibility.Collapsed;
        LaterButton.Content = "Close";
        try
        {
            var info = await UpdateService.CheckAsync();
            if (info == null)
            {
                HeadlineText.Text = "You're up to date";
                NotesText.Text = $"PDF and Moore {UpdateService.CurrentVersion.ToString(3)} is the newest version.";
                return;
            }
            ShowRelease(info);
        }
        catch (Exception ex)
        {
            HeadlineText.Text = "Couldn't check for updates";
            NotesText.Text = "PDF and Moore couldn't reach GitHub. Check your internet connection and try again.\n\n" + ex.Message;
        }
    }

    private void ShowRelease(UpdateInfo info)
    {
        _info = info;
        HeadlineText.Text = $"PDF and Moore {info.Version.ToString(3)} is ready";
        VersionText.Text = $"You have {UpdateService.CurrentVersion.ToString(3)}. " +
                           $"Download size about {Math.Max(1, info.DownloadSize / (1024 * 1024))} MB.";
        NotesText.Text = string.IsNullOrWhiteSpace(info.ReleaseNotes) ? "No release notes." : info.ReleaseNotes.Trim();
        UpdateButton.Visibility = SkipButton.Visibility = Visibility.Visible;
        UpdateButton.Content = "Update now";
        LaterButton.Content = "Later";
    }

    private void ShowInstalled()
    {
        _done = true;
        HeadlineText.Text = "Update installed";
        VersionText.Text = "The new version starts the next time you open PDF and Moore.";
        NotesText.Text = "Restart now to switch over. Open files are closed the normal way, so you'll still be asked to save any changes.";
        StatusText.Text = "";
        DownloadProgress.Visibility = Visibility.Collapsed;
        UpdateButton.Visibility = Visibility.Visible;
        UpdateButton.Content = "Restart now";
        SkipButton.Visibility = Visibility.Collapsed;
        LaterButton.Content = "Later";
        LaterButton.IsEnabled = true;
    }

    private async void UpdateButton_Click(object sender, RoutedEventArgs e)
    {
        if (_done)
        {
            RestartNow();
            return;
        }
        if (_info == null) return;

        _installing = true;
        UpdateButton.IsEnabled = LaterButton.IsEnabled = SkipButton.IsEnabled = false;
        DownloadProgress.Visibility = Visibility.Visible;
        DownloadProgress.Value = 0;
        StatusText.Text = "Downloading…";
        var progress = new Progress<double>(p =>
        {
            DownloadProgress.Value = p;
            StatusText.Text = $"Downloading… {p:P0}";
        });
        try
        {
            await Task.Run(() => UpdateService.DownloadAndInstallAsync(_info, progress));
            _installing = false;
            UpdateButton.IsEnabled = true;
            ShowInstalled();
        }
        catch (Exception ex)
        {
            _installing = false;
            DownloadProgress.Visibility = Visibility.Collapsed;
            StatusText.Text = "The update didn't install, and your current version is unchanged. " + ex.Message;
            UpdateButton.IsEnabled = LaterButton.IsEnabled = SkipButton.IsEnabled = true;
        }
    }

    /// <summary>Close every window the normal way (each asks about unsaved changes); the app starts the new version as it exits.</summary>
    private void RestartNow()
    {
        UpdateService.RelaunchOnExit = true;
        Close();
        foreach (Window w in Application.Current.Windows.Cast<Window>().ToList())
        {
            if (w != this && w is not ClaudeWebWindow) w.Close(); // the main window closes its Claude window itself
        }
    }

    private void LaterButton_Click(object sender, RoutedEventArgs e) => Close();

    private void SkipButton_Click(object sender, RoutedEventArgs e)
    {
        if (_info != null) UpdateService.Skip(_info);
        Close();
    }

    /// <summary>v9: match the app's Dark theme and bigger text.</summary>
    private void ApplyLook()
    {
        var prefs = UiPrefs.Load();
        if (prefs.TextSize != "normal") FontSize = 14.5;
        if (!prefs.IsDark) return;
        static System.Windows.Media.SolidColorBrush B(string hex) =>
            new((System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex));
        Background = B("#0F1B2D");
        Foreground = B("#EAF1F8");
        NotesBorder.Background = B("#16253A");
        NotesBorder.BorderBrush = B("#2A3F5C");
        VersionText.Foreground = B("#8FA6BD");
        StatusText.Foreground = B("#8FA6BD");
        AutoCheckBox.Foreground = B("#C9D6E3");
        UpdateButton.Background = B("#FF7A59");
        foreach (var b in new[] { LaterButton, SkipButton })
        {
            b.Foreground = B("#5AB8FF");
            b.BorderBrush = B("#2A3F5C");
        }
        DownloadProgress.Foreground = B("#FF7A59");
        DownloadProgress.Background = B("#1F3D63");
    }
}
