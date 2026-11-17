using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using PdfAndMoore.Services;

namespace PdfAndMoore;

// =====================================================================
//  v9.9 Profiles: "Who's using PDF and Moore?", Manage people, and the
//  small name / PIN windows. Built in code with the Pam.* styles in App.xaml.
// =====================================================================

/// <summary>Small helpers so every profile window has the same dark "Moore" look.</summary>
internal static class Ui
{
    public static Style S(string key) => (Style)Application.Current.FindResource(key);
    public static Brush B(string key) => (Brush)Application.Current.FindResource(key);

    public static Brush Hex(string hex)
    {
        try { return new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); }
        catch { return Brushes.SlateGray; }
    }

    /// <summary>Colors a window (and its title bar) in the app's dark theme.</summary>
    public static void Apply(Window w, Window? owner)
    {
        w.Background = B("Pam.Bg");
        w.Foreground = B("Pam.Text");
        w.FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
        w.FontSize = 14;
        w.UseLayoutRounding = true;
        try { w.Icon = new BitmapImage(new Uri("pack://application:,,,/Assets/app.ico")); } catch { }
        if (owner != null && owner.IsLoaded)
        {
            w.Owner = owner;
            w.WindowStartupLocation = WindowStartupLocation.CenterOwner;
            w.ShowInTaskbar = false;
        }
        else
        {
            w.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        }
        w.SourceInitialized += (_, _) => DarkTitleBar(w);
    }

    /// <summary>A small modal window that grows to fit what's in it.</summary>
    public static Window Dialog(string title, Window? owner, double width = 440)
    {
        var w = new Window { Title = title, Width = width, SizeToContent = SizeToContent.Height, ResizeMode = ResizeMode.NoResize };
        Apply(w, owner);
        return w;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    private static void DarkTitleBar(Window w)
    {
        try
        {
            int on = 1;
            IntPtr hwnd = new WindowInteropHelper(w).Handle;
            if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) != 0) // DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 11 / 10 20H1+)
                DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int));     // older Windows 10 builds
        }
        catch { }
    }

    /// <summary>A round colored circle with the person's first letter.</summary>
    public static FrameworkElement Avatar(Profile p, double size)
    {
        var g = new Grid { Width = size, Height = size };
        g.Children.Add(new Ellipse { Fill = Hex(p.Color) });
        g.Children.Add(new TextBlock
        {
            Text = p.Initial,
            Foreground = Brushes.White,
            FontSize = size * 0.46,
            FontWeight = FontWeights.Bold,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        });
        return g;
    }

    public static TextBlock Text(string text, double size = 14, bool muted = false, bool bold = false) => new()
    {
        Text = text,
        FontSize = size,
        TextWrapping = TextWrapping.Wrap,
        Foreground = muted ? B("Pam.Muted") : B("Pam.Text"),
        FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
    };

    public static TextBlock ErrorText() => new()
    {
        Foreground = B("Pam.Error"),
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 8, 0, 0),
        Visibility = Visibility.Collapsed,
    };

    public static void ShowError(TextBlock t, string message)
    {
        t.Text = message;
        t.Visibility = Visibility.Visible;
    }

    public static Button Btn(string text, string style = "Pam.Pill", RoutedEventHandler? click = null)
    {
        var b = new Button { Content = text, Style = S(style) };
        if (click != null) b.Click += click;
        return b;
    }

    public static StackPanel ButtonRow(params Button[] buttons)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 20, 0, 0) };
        foreach (var b in buttons) row.Children.Add(b);
        return row;
    }

    public static TextBox TextInput(string value) => new()
    {
        Text = value,
        Style = S("Pam.Input"),
        CaretBrush = B("Pam.Text"),
        Margin = new Thickness(0, 10, 0, 0),
        MaxLength = 30,
    };

    public static PasswordBox PinInput() => new()
    {
        Style = S("Pam.Input"),
        CaretBrush = B("Pam.Text"),
        Margin = new Thickness(0, 10, 0, 0),
        MaxLength = Profiles.MaxPin,
        FontSize = 22,
    };
}

/// <summary>The little windows for names, PINs and "are you sure?".</summary>
internal static class ProfileDialogs
{
    public enum PinResult { Ok, Cancel, Forgot }

    // Wrong-PIN lockout: after 5 wrong tries, wait 30 seconds.
    private static readonly Dictionary<string, (int Fails, DateTime Until)> Tries = new();
    private const int MaxTries = 5;
    private static readonly TimeSpan LockFor = TimeSpan.FromSeconds(30);

    /// <summary>Ask for a name. Returns the cleaned-up name, or null if cancelled.</summary>
    public static string? AskName(Window? owner, string title, string prompt, string initial, Func<string, string?> check)
    {
        var w = Ui.Dialog(title, owner);
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(Ui.Text(prompt, 15));
        var box = Ui.TextInput(initial);
        panel.Children.Add(box);
        var err = Ui.ErrorText();
        panel.Children.Add(err);
        var ok = Ui.Btn("OK", "Pam.Primary");
        ok.IsDefault = true;
        ok.Click += (_, _) =>
        {
            string? problem = check(box.Text);
            if (problem != null) { Ui.ShowError(err, problem); box.Focus(); return; }
            w.DialogResult = true;
        };
        var cancel = Ui.Btn("Cancel");
        cancel.IsCancel = true;
        panel.Children.Add(Ui.ButtonRow(cancel, ok));
        w.Content = panel;
        w.Loaded += (_, _) => { box.Focus(); box.SelectAll(); };
        return w.ShowDialog() == true ? Profiles.Clean(box.Text) : null;
    }

    /// <summary>Ask for someone's PIN (checked here, with the wrong-PIN lockout).</summary>
    public static PinResult AskPin(Window? owner, Profile p, string prompt, bool allowForgot)
    {
        var w = Ui.Dialog("Enter PIN", owner, 400);
        var result = PinResult.Cancel;
        var panel = new StackPanel { Margin = new Thickness(24) };

        var head = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 6) };
        head.Children.Add(Ui.Avatar(p, 44));
        var name = Ui.Text(p.Name, 18, bold: true);
        name.VerticalAlignment = VerticalAlignment.Center;
        name.Margin = new Thickness(12, 0, 0, 0);
        head.Children.Add(name);
        panel.Children.Add(head);
        panel.Children.Add(Ui.Text(prompt, 14, muted: true));

        var pin = Ui.PinInput();
        panel.Children.Add(pin);
        var err = Ui.ErrorText();
        panel.Children.Add(err);

        var ok = Ui.Btn("Sign in", "Pam.Primary");
        ok.IsDefault = true;
        ok.Click += (_, _) =>
        {
            if (Tries.TryGetValue(p.Id, out var t) && t.Until > DateTime.Now)
            {
                Ui.ShowError(err, $"Too many wrong tries. Wait {(int)Math.Ceiling((t.Until - DateTime.Now).TotalSeconds)} seconds.");
                return;
            }
            if (Profiles.CheckPin(p, pin.Password))
            {
                Tries.Remove(p.Id);
                result = PinResult.Ok;
                w.DialogResult = true;
                return;
            }
            int fails = (Tries.TryGetValue(p.Id, out t) ? t.Fails : 0) + 1;
            Tries[p.Id] = fails >= MaxTries ? (0, DateTime.Now + LockFor) : (fails, DateTime.MinValue);
            Ui.ShowError(err, fails >= MaxTries ? $"That PIN isn't right. Wait {(int)LockFor.TotalSeconds} seconds and try again." : "That PIN isn't right.");
            pin.Clear();
            pin.Focus();
        };
        var cancel = Ui.Btn("Cancel");
        cancel.IsCancel = true;
        var row = Ui.ButtonRow(cancel, ok);

        if (allowForgot)
        {
            var grid = new DockPanel { Margin = new Thickness(0, 20, 0, 0) };
            var forgot = Ui.Btn("Forgot PIN?", "Pam.Link", (_, _) => { result = PinResult.Forgot; w.DialogResult = true; });
            forgot.VerticalAlignment = VerticalAlignment.Center;
            DockPanel.SetDock(forgot, Dock.Left);
            grid.Children.Add(forgot);
            row.Margin = new Thickness(0);
            grid.Children.Add(row);
            panel.Children.Add(grid);
        }
        else
        {
            panel.Children.Add(row);
        }

        w.Content = panel;
        w.Loaded += (_, _) => pin.Focus();
        w.ShowDialog();
        return result;
    }

    /// <summary>Ask for a new PIN twice. Returns it, or null if cancelled.</summary>
    public static string? AskNewPin(Window? owner, Profile p)
    {
        var w = Ui.Dialog("Set a PIN", owner, 420);
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(Ui.Text($"Choose a PIN for {p.Name}", 18, bold: true));
        panel.Children.Add(Ui.Text($"{Profiles.MinPin} to {Profiles.MaxPin} numbers. You'll type it when you sign in.", 14, muted: true));
        var first = Ui.PinInput();
        panel.Children.Add(first);
        panel.Children.Add(new TextBlock { Text = "Type it again", Foreground = Ui.B("Pam.Muted"), Margin = new Thickness(0, 12, 0, 0) });
        var second = Ui.PinInput();
        second.Margin = new Thickness(0, 6, 0, 0);
        panel.Children.Add(second);
        var err = Ui.ErrorText();
        panel.Children.Add(err);

        var ok = Ui.Btn("Save PIN", "Pam.Primary");
        ok.IsDefault = true;
        ok.Click += (_, _) =>
        {
            if (!Profiles.IsValidPin(first.Password)) { Ui.ShowError(err, $"Use {Profiles.MinPin} to {Profiles.MaxPin} numbers (0-9)."); first.Focus(); return; }
            if (first.Password != second.Password) { Ui.ShowError(err, "The two PINs don't match. Try again."); second.Clear(); second.Focus(); return; }
            w.DialogResult = true;
        };
        var cancel = Ui.Btn("Cancel");
        cancel.IsCancel = true;
        panel.Children.Add(Ui.ButtonRow(cancel, ok));
        w.Content = panel;
        w.Loaded += (_, _) => first.Focus();
        return w.ShowDialog() == true ? first.Password : null;
    }

    /// <summary>A yes/no question in the app's look.</summary>
    public static bool Confirm(Window? owner, string title, string heading, string message, string yes, string no = "Cancel", bool danger = false)
    {
        var w = Ui.Dialog(title, owner, 460);
        var panel = new StackPanel { Margin = new Thickness(24) };
        panel.Children.Add(Ui.Text(heading, 18, bold: true));
        var body = Ui.Text(message, 14, muted: true);
        body.Margin = new Thickness(0, 8, 0, 0);
        panel.Children.Add(body);
        var ok = Ui.Btn(yes, danger ? "Pam.Danger" : "Pam.Primary", (_, _) => w.DialogResult = true);
        var cancel = Ui.Btn(no);
        cancel.IsCancel = true;
        if (!danger) ok.IsDefault = true; else cancel.IsDefault = true;
        panel.Children.Add(Ui.ButtonRow(cancel, ok));
        w.Content = panel;
        return w.ShowDialog() == true;
    }

    /// <summary>Asks for this person's PIN before changing their profile. True when they have no PIN or typed it right.</summary>
    public static bool Unlock(Window? owner, Profile p, string why) =>
        !p.HasPin || AskPin(owner, p, why, allowForgot: false) == PinResult.Ok;

    /// <summary>Add someone, then offer to give them a PIN. Returns the new person or null.</summary>
    public static Profile? AddPerson(Window? owner)
    {
        string? name = AskName(owner, "Add a person", "What's their name?", "", n => Profiles.CheckName(Profiles.Load(), n));
        if (name == null) return null;
        var list = Profiles.Load();
        var p = Profiles.Add(list, name);
        if (Confirm(owner, "Add a person", $"Add a PIN for {p.Name}?",
                $"A PIN keeps other people out of {p.Name}'s Claude sign-in, email, saved signature and recent files. You can add or change it later in Manage people.",
                "Add a PIN", "Not now"))
        {
            string? pin = AskNewPin(owner, p);
            if (pin != null) Profiles.SetPin(list, p, pin);
        }
        return p;
    }

    /// <summary>"Forgot PIN?": explain what resetting does, and do it if they agree.</summary>
    public static bool ResetForgotten(Window? owner, Profile p)
    {
        if (!Confirm(owner, "Forgot PIN", $"Reset {p.Name}'s PIN?",
                $"To keep {p.Name}'s things private, resetting the PIN also signs {p.Name} out of everything saved in PDF and Moore on this PC: " +
                "the Claude sign-in, saved signature, Claude API key and email passwords (the email accounts stay; just type the app passwords again). " +
                "Settings and recent files stay. Nothing is deleted from Claude, Gmail or anyone's documents.",
                "Reset PIN", danger: true))
            return false;
        try
        {
            var list = Profiles.Load();
            var fresh = Profiles.Find(list, p.Id) ?? p;
            Profiles.ResetForgottenPin(list, fresh);
            if (Confirm(owner, "Forgot PIN", $"Choose a new PIN for {p.Name}?", "You can also do this later in Manage people.", "Choose a PIN", "Not now"))
            {
                string? pin = AskNewPin(owner, fresh);
                if (pin != null) Profiles.SetPin(list, fresh, pin);
            }
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "PDF and Moore", MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }
    }
}

/// <summary>"Who's using PDF and Moore?" shown at start-up and after signing out.</summary>
public sealed class ProfilePickerWindow : Window
{
    private readonly WrapPanel _tiles = new() { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 6) };

    /// <summary>The person who signed in (null if the window was closed).</summary>
    public Profile? Chosen { get; private set; }

    public ProfilePickerWindow(string? note = null)
    {
        Title = "PDF and Moore";
        Width = 820;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.CanMinimize;
        Ui.Apply(this, null);

        var root = new StackPanel { Margin = new Thickness(32, 28, 32, 24) };
        try
        {
            root.Children.Add(new Image
            {
                Source = new BitmapImage(new Uri("pack://application:,,,/Assets/app.png")),
                Width = 64, Height = 64,
                HorizontalAlignment = HorizontalAlignment.Center,
            });
        }
        catch { }
        var head = Ui.Text("Who's using PDF and Moore?", 28, bold: true);
        head.HorizontalAlignment = HorizontalAlignment.Center;
        head.Margin = new Thickness(0, 12, 0, 0);
        root.Children.Add(head);
        if (!string.IsNullOrEmpty(note))
        {
            var n = Ui.Text(note, 15, muted: true);
            n.HorizontalAlignment = HorizontalAlignment.Center;
            n.Margin = new Thickness(0, 6, 0, 0);
            root.Children.Add(n);
        }
        root.Children.Add(_tiles);

        var manage = Ui.Btn("Manage people", "Pam.Link", (_, _) =>
        {
            new ManagePeopleWindow(this).ShowDialog();
            Build();
        });
        manage.HorizontalAlignment = HorizontalAlignment.Center;
        root.Children.Add(manage);

        Content = root;
        Build();
        Loaded += (_, _) => (_tiles.Children.Count > 0 ? _tiles.Children[0] as UIElement : null)?.Focus();
    }

    private void Build()
    {
        _tiles.Children.Clear();
        foreach (var p in Profiles.Load().Profiles)
        {
            var stack = new StackPanel();
            var av = Ui.Avatar(p, 84);
            av.HorizontalAlignment = HorizontalAlignment.Center;
            stack.Children.Add(av);
            var name = Ui.Text(p.Name, 17, bold: true);
            name.HorizontalAlignment = HorizontalAlignment.Center;
            name.TextAlignment = TextAlignment.Center;
            name.TextTrimming = TextTrimming.CharacterEllipsis;
            name.TextWrapping = TextWrapping.NoWrap;
            name.MaxWidth = 128;
            name.Margin = new Thickness(0, 12, 0, 0);
            stack.Children.Add(name);
            var sub = Ui.Text(p.HasPin ? "PIN" : " ", 12, muted: true);
            sub.HorizontalAlignment = HorizontalAlignment.Center;
            stack.Children.Add(sub);

            var tile = new Button { Style = Ui.S("Pam.Tile"), Content = stack, ToolTip = "Sign in as " + p.Name };
            AutomationName(tile, "Sign in as " + p.Name);
            string id = p.Id;
            tile.Click += (_, _) => Choose(id);
            _tiles.Children.Add(tile);
        }

        var add = new StackPanel();
        var plus = new Grid { Width = 84, Height = 84, HorizontalAlignment = HorizontalAlignment.Center };
        plus.Children.Add(new Ellipse { Stroke = Ui.B("Pam.Muted"), StrokeThickness = 2, StrokeDashArray = new DoubleCollection { 3, 3 } });
        plus.Children.Add(new TextBlock { Text = "+", FontSize = 40, Foreground = Ui.B("Pam.Muted"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, -6, 0, 0) });
        add.Children.Add(plus);
        var addText = Ui.Text("Add person", 17, muted: true);
        addText.HorizontalAlignment = HorizontalAlignment.Center;
        addText.Margin = new Thickness(0, 12, 0, 0);
        add.Children.Add(addText);
        var addTile = new Button { Style = Ui.S("Pam.Tile"), Content = add, ToolTip = "Add someone who uses this PC" };
        AutomationName(addTile, "Add person");
        addTile.Click += (_, _) => { ProfileDialogs.AddPerson(this); Build(); };
        _tiles.Children.Add(addTile);
    }

    private static void AutomationName(UIElement e, string name) =>
        System.Windows.Automation.AutomationProperties.SetName(e, name);

    private void Choose(string id)
    {
        var p = Profiles.Find(Profiles.Load(), id); // fresh: a PIN may have just changed
        if (p == null) { Build(); return; }
        if (p.HasPin)
        {
            var r = ProfileDialogs.AskPin(this, p, "Type your PIN to sign in.", allowForgot: true);
            if (r == ProfileDialogs.PinResult.Cancel) return;
            if (r == ProfileDialogs.PinResult.Forgot)
            {
                if (!ProfileDialogs.ResetForgotten(this, p)) return;
                Build();
            }
        }
        Chosen = Profiles.Find(Profiles.Load(), id) ?? p;
        DialogResult = true;
    }
}

/// <summary>Manage people: add, rename, PINs, remove, and "ask every time".</summary>
public sealed class ManagePeopleWindow : Window
{
    private readonly StackPanel _rows = new();
    private readonly CheckBox _askEveryTime;

    public ManagePeopleWindow(Window? owner)
    {
        Title = "Manage people - PDF and Moore";
        Width = 680;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        Ui.Apply(this, owner);

        var root = new StackPanel { Margin = new Thickness(28, 24, 28, 22) };
        root.Children.Add(Ui.Text("People who use PDF and Moore on this PC", 20, bold: true));
        var intro = Ui.Text("Each person has their own settings, Claude sign-in, email, saved signature, recent files and backups.", 14, muted: true);
        intro.Margin = new Thickness(0, 6, 0, 12);
        root.Children.Add(intro);

        var scroll = new ScrollViewer { Content = _rows, MaxHeight = 420, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        root.Children.Add(scroll);

        var add = Ui.Btn("+ Add person", "Pam.Pill", (_, _) => { ProfileDialogs.AddPerson(this); Build(); });
        add.HorizontalAlignment = HorizontalAlignment.Left;
        add.Margin = new Thickness(0, 12, 0, 0);
        root.Children.Add(add);

        _askEveryTime = new CheckBox
        {
            Content = "Ask \"Who's using PDF and Moore?\" every time it starts, even with one person",
            Foreground = Ui.B("Pam.Text"),
            Margin = new Thickness(0, 18, 0, 0),
            IsChecked = Profiles.Load().AskEveryTime,
        };
        _askEveryTime.Click += (_, _) =>
        {
            var list = Profiles.Load();
            list.AskEveryTime = _askEveryTime.IsChecked == true;
            Profiles.Save(list);
        };
        root.Children.Add(_askEveryTime);

        var note = Ui.Text("A PIN keeps people out of each other's things inside PDF and Moore. For the strongest privacy, " +
                           "give each person their own Windows account. Digital IDs (Protect › Sign with digital ID) belong to the Windows account, so everyone on it shares them.",
            12.5, muted: true);
        note.Margin = new Thickness(0, 14, 0, 0);
        root.Children.Add(note);

        var done = Ui.Btn("Done", "Pam.Primary", (_, _) => Close());
        done.IsDefault = true;
        done.IsCancel = true;
        root.Children.Add(Ui.ButtonRow(done));

        Content = root;
        Build();
    }

    private void Build()
    {
        _rows.Children.Clear();
        var list = Profiles.Load();
        foreach (var p in list.Profiles)
        {
            bool isMe = Profiles.Current?.Id == p.Id;
            var row = new Border
            {
                Background = Ui.B("Pam.Surface"),
                BorderBrush = Ui.B("Pam.Border"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(14),
                Padding = new Thickness(14, 10, 10, 10),
                Margin = new Thickness(0, 0, 0, 8),
            };
            var dock = new DockPanel();
            var av = Ui.Avatar(p, 42);
            DockPanel.SetDock(av, Dock.Left);
            dock.Children.Add(av);

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            string id = p.Id;
            buttons.Children.Add(Small("Rename", (_, _) => Rename(id)));
            buttons.Children.Add(Small(p.HasPin ? "Change PIN" : "Add PIN", (_, _) => ChangePin(id)));
            if (p.HasPin) buttons.Children.Add(Small("Remove PIN", (_, _) => RemovePin(id)));
            var remove = Small("Remove", (_, _) => Remove(id));
            remove.Style = Ui.S("Pam.Danger");
            remove.Padding = new Thickness(12, 6, 12, 6);
            remove.FontSize = 13;
            remove.IsEnabled = !isMe && list.Profiles.Count > 1;
            remove.ToolTip = isMe ? "You can't remove yourself while you're signed in." : list.Profiles.Count <= 1 ? "There has to be at least one person." : "Remove " + p.Name;
            ToolTipService.SetShowOnDisabled(remove, true);
            buttons.Children.Add(remove);
            DockPanel.SetDock(buttons, Dock.Right);
            dock.Children.Add(buttons);

            var text = new StackPanel { Margin = new Thickness(12, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
            var name = Ui.Text(p.Name + (isMe ? "  (you)" : ""), 16, bold: true);
            name.TextTrimming = TextTrimming.CharacterEllipsis;
            name.TextWrapping = TextWrapping.NoWrap;
            text.Children.Add(name);
            text.Children.Add(Ui.Text(p.HasPin ? "Locked with a PIN" : "No PIN", 12.5, muted: true));
            dock.Children.Add(text);

            row.Child = dock;
            _rows.Children.Add(row);
        }
    }

    private static Button Small(string text, RoutedEventHandler click)
    {
        var b = Ui.Btn(text, "Pam.Pill", click);
        b.Padding = new Thickness(12, 6, 12, 6);
        b.FontSize = 13;
        return b;
    }

    private (ProfileList list, Profile? p) Fresh(string id)
    {
        var list = Profiles.Load();
        return (list, Profiles.Find(list, id));
    }

    private void Rename(string id)
    {
        var (list, p) = Fresh(id);
        if (p == null || !ProfileDialogs.Unlock(this, p, $"Type {p.Name}'s PIN to make changes.")) return;
        string? name = ProfileDialogs.AskName(this, "Rename", $"New name for {p.Name}:", p.Name, n => Profiles.CheckName(Profiles.Load(), n, Profiles.Find(Profiles.Load(), id)));
        if (name == null) return;
        (list, p) = Fresh(id);
        if (p == null) return;
        p.Name = name;
        Profiles.Save(list);
        Profiles.Refresh(list);
        Build();
    }

    private void ChangePin(string id)
    {
        var (list, p) = Fresh(id);
        if (p == null || !ProfileDialogs.Unlock(this, p, $"Type {p.Name}'s current PIN.")) return;
        string? pin = ProfileDialogs.AskNewPin(this, p);
        if (pin == null) return;
        (list, p) = Fresh(id);
        if (p == null) return;
        Profiles.SetPin(list, p, pin);
        Profiles.Refresh(list);
        Build();
    }

    private void RemovePin(string id)
    {
        var (list, p) = Fresh(id);
        if (p == null || !ProfileDialogs.Unlock(this, p, $"Type {p.Name}'s PIN to remove it.")) return;
        (list, p) = Fresh(id);
        if (p == null) return;
        Profiles.ClearPin(list, p);
        Profiles.Refresh(list);
        Build();
    }

    private void Remove(string id)
    {
        var (list, p) = Fresh(id);
        if (p == null) return;
        if (!ProfileDialogs.Unlock(this, p, $"Type {p.Name}'s PIN to remove {p.Name}.")) return;
        if (!ProfileDialogs.Confirm(this, "Remove person", $"Remove {p.Name}?",
                $"This deletes {p.Name}'s PDF and Moore settings, Claude sign-in, email setup, saved signature, recent files list and backups on this PC. " +
                $"{p.Name}'s documents are not touched, and nothing is deleted from Claude or Gmail.",
                "Remove " + p.Name, danger: true))
            return;
        try
        {
            (list, p) = Fresh(id);
            if (p != null) Profiles.Delete(list, p);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "PDF and Moore", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        Build();
    }
}
