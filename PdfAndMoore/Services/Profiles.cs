using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace PdfAndMoore.Services;

/// <summary>One person who uses PDF and Moore on this PC (v9.9 Profiles).</summary>
public sealed class Profile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#FF7A59";

    /// <summary>
    /// Folder name under Profiles\ in %APPDATA%\PdfAndMoore and %LOCALAPPDATA%\PdfAndMoore.
    /// "" means this profile still uses the old, pre-profile folders (it moves over the next time it can).
    /// </summary>
    public string Folder { get; set; } = "";

    /// <summary>The first profile (made from the data that was here before v9.9). Gets John's mail setup on a fresh start.</summary>
    public bool Owner { get; set; }

    /// <summary>PIN as a salted PBKDF2-SHA256 hash. The PIN itself is never saved.</summary>
    public string PinHash { get; set; } = "";
    public string PinSalt { get; set; } = "";
    public int PinIterations { get; set; }

    public DateTime Created { get; set; }
    public DateTime LastUsed { get; set; }

    [JsonIgnore] public bool HasPin => PinHash.Length > 0;

    [JsonIgnore]
    public string Initial => string.IsNullOrWhiteSpace(Name) ? "?" : Name.Trim()[..1].ToUpperInvariant();
}

/// <summary>Everyone who uses the app on this PC, saved in %APPDATA%\PdfAndMoore\profiles.json.</summary>
public sealed class ProfileList
{
    public int Version { get; set; } = 1;
    public List<Profile> Profiles { get; set; } = new();

    /// <summary>Show "Who's using PDF and Moore?" every time, even when only one person is set up.</summary>
    public bool AskEveryTime { get; set; }
}

/// <summary>
/// Profiles (v9.9): several people can share PDF and Moore on one Windows account. Each person gets their own
/// settings, Claude sign-in, API key, email accounts, saved signature, recent files and backups, and can lock
/// them with a PIN. Signing out closes the app's windows and goes back to "Who's using PDF and Moore?".
///
/// Where things live:
///   %APPDATA%\PdfAndMoore\profiles.json                      the list of people (shared)
///   %APPDATA%\PdfAndMoore\Profiles\&lt;id&gt;\                    settings.json, mail.json, recent.json, ui.json
///   %LOCALAPPDATA%\PdfAndMoore\Profiles\&lt;id&gt;\WebView2        Claude sign-in, saved signature, on-device AI download
///   %LOCALAPPDATA%\PdfAndMoore\Profiles\&lt;id&gt;\Backups         originals kept before the first overwrite
///   %LOCALAPPDATA%\PdfAndMoore\session.json                  who is signed in while the app is open
/// update-settings.json and crash.log stay shared.
///
/// A PIN keeps other people at the shop out of your things inside the app. It is not as strong as a separate
/// Windows account: someone who signs in to Windows as you and knows where to look could still read the files.
/// </summary>
public static class Profiles
{
    public static readonly string RoamingRoot =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore");

    public static readonly string LocalRoot =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PdfAndMoore");

    private static string ListFile => Path.Combine(RoamingRoot, "profiles.json");
    private static string SessionFile => Path.Combine(LocalRoot, "session.json");

    /// <summary>Files that belong to one person (in their roaming folder).</summary>
    private static readonly string[] PersonalFiles = { "settings.json", "mail.json", "mail.json.bad", "recent.json", "ui.json" };

    /// <summary>Avatar colors, in the order new people get them.</summary>
    public static readonly string[] Colors =
        { "#FF7A59", "#2BB3D9", "#3FC28A", "#9B6BFF", "#FF5FA2", "#FFC845", "#5B8DEF", "#D97757" };

    public const int MinPin = 4;
    public const int MaxPin = 8;
    private const int PinIterationCount = 200_000;

    private static readonly JsonSerializerOptions FileJson = new() { WriteIndented = true };

    /// <summary>The person signed in to this copy of the app (null until someone signs in).</summary>
    public static Profile? Current { get; private set; }

    private static int _count = 1;

    /// <summary>How many people are set up (as of the last load or save).</summary>
    public static int Count => _count;

    // ------------------------------------------------------------------
    //  Folders for the signed-in person
    // ------------------------------------------------------------------

    /// <summary>The signed-in person's roaming folder (settings, mail, recent files, look &amp; feel).</summary>
    public static string DataDir => DataDirOf(Current);

    /// <summary>The signed-in person's local folder (WebView2 sign-ins, backups).</summary>
    public static string LocalDir => LocalDirOf(Current);

    public static string DataDirOf(Profile? p) =>
        p is { Folder.Length: > 0 } ? Path.Combine(RoamingRoot, "Profiles", p.Folder) : RoamingRoot;

    public static string LocalDirOf(Profile? p) =>
        p is { Folder.Length: > 0 } ? Path.Combine(LocalRoot, "Profiles", p.Folder) : LocalRoot;

    /// <summary>True when the signed-in person is the first profile (John's own setup).</summary>
    public static bool IsOwner => Current?.Owner ?? true;

    /// <summary>" - John" after window titles when more than one person uses the app, so it's clear who is signed in.</summary>
    public static string TitleSuffix => Current != null && _count > 1 ? " - " + Current.Name : "";

    // ------------------------------------------------------------------
    //  The list of people
    // ------------------------------------------------------------------

    /// <summary>Loads the list. The very first time, the data already on this PC becomes the first profile.</summary>
    public static ProfileList Load()
    {
        ProfileList? list = null;
        try
        {
            if (File.Exists(ListFile))
                list = JsonSerializer.Deserialize<ProfileList>(File.ReadAllText(ListFile));
        }
        catch
        {
            // A damaged list: keep a copy and start over from what's on disk (nobody's files are touched).
            try { File.Copy(ListFile, ListFile + ".bad", true); } catch { }
        }

        if ((list == null || list.Profiles.Count == 0) && Recover() is { Profiles.Count: > 0 } recovered)
        {
            list = recovered;
            Save(list);
        }
        if (list == null || list.Profiles.Count == 0)
        {
            list = new ProfileList();
            var first = NewProfile(list, FirstName());
            first.Folder = ""; // starts out in the old folders; MoveToOwnFolder moves it when it can
            first.Owner = true;
            list.Profiles.Add(first);
            Save(list);
        }
        _count = list.Profiles.Count;
        return list;
    }

    /// <summary>If profiles.json was lost or damaged, rebuild the list from the folders under Profiles\ (no PINs).</summary>
    private static ProfileList? Recover()
    {
        try
        {
            string dir = Path.Combine(RoamingRoot, "Profiles");
            if (!Directory.Exists(dir)) return null;
            var list = new ProfileList();
            foreach (string folder in Directory.GetDirectories(dir).OrderBy(Directory.GetCreationTime))
            {
                string id = Path.GetFileName(folder);
                string name = "";
                try
                {
                    string settings = Path.Combine(folder, "settings.json");
                    if (File.Exists(settings)) name = JsonNode.Parse(File.ReadAllText(settings))?["UserName"]?.GetValue<string>() ?? "";
                }
                catch { }
                name = Clean(name);
                if (name.Length == 0 || list.Profiles.Any(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                    name = "Person " + (list.Profiles.Count + 1);
                list.Profiles.Add(new Profile
                {
                    Id = id, Folder = id, Name = name, Owner = list.Profiles.Count == 0,
                    Color = Colors[list.Profiles.Count % Colors.Length], Created = DateTime.Now,
                });
            }
            return list;
        }
        catch { return null; }
    }

    public static void Save(ProfileList list)
    {
        Directory.CreateDirectory(RoamingRoot);
        string tmp = ListFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(list, FileJson));
        File.Move(tmp, ListFile, overwrite: true);
        _count = list.Profiles.Count;
    }

    /// <summary>After a rename or PIN change, keep the signed-in person's details up to date.</summary>
    public static void Refresh(ProfileList list)
    {
        if (Current != null && Find(list, Current.Id) is { } p)
        {
            p.Folder = Current.Folder; // this copy of the app keeps using the folder it started with
            Current = p;
        }
        _count = list.Profiles.Count;
    }

    /// <summary>Finds one person in a freshly loaded list (another copy of the app may have changed their PIN or name).</summary>
    public static Profile? Find(ProfileList list, string id) =>
        list.Profiles.FirstOrDefault(p => p.Id == id);

    /// <summary>The name for the first profile: the name in Settings, or the Windows user name.</summary>
    private static string FirstName()
    {
        try
        {
            string old = Path.Combine(RoamingRoot, "settings.json");
            if (File.Exists(old) && JsonNode.Parse(File.ReadAllText(old))?["UserName"]?.GetValue<string>() is { Length: > 0 } n)
                return Clean(n.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0]);
        }
        catch { }
        string user = Environment.UserName;
        return string.IsNullOrWhiteSpace(user) ? "Me" : Clean(char.ToUpperInvariant(user[0]) + user[1..]);
    }

    public static string Clean(string name)
    {
        string n = string.Join(' ', (name ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return n.Length > 30 ? n[..30].TrimEnd() : n;
    }

    private static Profile NewProfile(ProfileList list, string name)
    {
        string id = Guid.NewGuid().ToString("N")[..10];
        string color = Colors.FirstOrDefault(c => !list.Profiles.Any(p => p.Color.Equals(c, StringComparison.OrdinalIgnoreCase)))
                       ?? Colors[list.Profiles.Count % Colors.Length];
        return new Profile { Id = id, Name = Clean(name), Color = color, Folder = id, Created = DateTime.Now };
    }

    /// <summary>Returns a problem with this name, or null when it's fine.</summary>
    public static string? CheckName(ProfileList list, string name, Profile? except = null)
    {
        string n = Clean(name);
        if (n.Length == 0) return "Type a name.";
        if (list.Profiles.Any(p => p.Id != except?.Id && p.Name.Equals(n, StringComparison.OrdinalIgnoreCase)))
            return $"Someone is already called \"{n}\". Try a last initial, like \"{n} M\".";
        return null;
    }

    public static Profile Add(ProfileList list, string name)
    {
        var p = NewProfile(list, name);
        list.Profiles.Add(p);
        Directory.CreateDirectory(DataDirOf(p));
        Save(list);
        return p;
    }

    /// <summary>Removes a person and deletes everything PDF and Moore saved for them. Their documents are not touched.</summary>
    public static void Delete(ProfileList list, Profile p)
    {
        if (Current?.Id == p.Id) throw new InvalidOperationException("You can't remove yourself while you're signed in.");
        if (list.Profiles.Count <= 1) throw new InvalidOperationException("There has to be at least one person.");
        if (LiveSessionProfileId() == p.Id) throw new InvalidOperationException($"{p.Name} is signed in right now. Sign out first.");

        list.Profiles.RemoveAll(x => x.Id == p.Id);
        Save(list);

        if (p.Folder.Length > 0)
        {
            TryDeleteDir(DataDirOf(p));
            TryDeleteDir(LocalDirOf(p));
        }
        else
        {
            // Still in the old shared folders: delete only this person's things there.
            foreach (string f in PersonalFiles) TryDeleteFile(Path.Combine(RoamingRoot, f));
            TryDeleteDir(Path.Combine(LocalRoot, "WebView2"));
            TryDeleteDir(Path.Combine(LocalRoot, "Backups"));
        }
    }

    // ------------------------------------------------------------------
    //  Moving the first profile out of the old shared folders
    // ------------------------------------------------------------------

    /// <summary>
    /// Moves a profile that still uses the old (pre-v9.9) folders into its own folder under Profiles\.
    /// Nothing is lost if it can't (for example an older copy of the app is still open): it keeps using
    /// the old folders and tries again next time.
    /// </summary>
    public static void MoveToOwnFolder(ProfileList list, Profile p)
    {
        if (p.Folder.Length > 0) return;
        string id = p.Id;
        string roamDest = Path.Combine(RoamingRoot, "Profiles", id);
        string localDest = Path.Combine(LocalRoot, "Profiles", id);
        try
        {
            Directory.CreateDirectory(roamDest);
            Directory.CreateDirectory(localDest);

            // 1) The WebView2 folder is the only thing an open copy of the app holds on to. If it can't move, stop here.
            if (!TryMoveDir(Path.Combine(LocalRoot, "WebView2"), Path.Combine(localDest, "WebView2"))) return;

            // 2) Backups (just copies of documents; if they can't move, they stay where they are).
            TryMoveDir(Path.Combine(LocalRoot, "Backups"), Path.Combine(localDest, "Backups"));

            // 3) Settings, mail, recent files, look & feel.
            foreach (string f in PersonalFiles)
            {
                string src = Path.Combine(RoamingRoot, f);
                if (!File.Exists(src)) continue;
                File.Copy(src, Path.Combine(roamDest, f), overwrite: true);
                TryDeleteFile(src);
            }

            p.Folder = id;
            Save(list);
        }
        catch
        {
            // Try again next time; the old folders still work.
        }
    }

    private static bool TryMoveDir(string src, string dest)
    {
        if (!Directory.Exists(src)) return true;
        for (int attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                if (Directory.Exists(dest) && !Directory.EnumerateFileSystemEntries(dest).Any()) Directory.Delete(dest);
                Directory.Move(src, dest);
                return true;
            }
            catch (IOException) { Thread.Sleep(500); }      // still in use (an app that is closing, or an older copy)
            catch (UnauthorizedAccessException) { Thread.Sleep(500); }
        }
        return false;
    }

    private static void TryDeleteDir(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
    }

    private static void TryDeleteFile(string file)
    {
        try { if (File.Exists(file)) File.Delete(file); } catch { }
    }

    // ------------------------------------------------------------------
    //  PINs
    // ------------------------------------------------------------------

    public static bool IsValidPin(string pin) =>
        pin.Length >= MinPin && pin.Length <= MaxPin && pin.All(char.IsAsciiDigit);

    public static void SetPin(ProfileList list, Profile p, string pin)
    {
        if (!IsValidPin(pin)) throw new ArgumentException($"A PIN is {MinPin} to {MaxPin} numbers.");
        byte[] salt = RandomNumberGenerator.GetBytes(16);
        byte[] hash = Rfc2898DeriveBytes.Pbkdf2(pin, salt, PinIterationCount, HashAlgorithmName.SHA256, 32);
        p.PinSalt = Convert.ToBase64String(salt);
        p.PinHash = Convert.ToBase64String(hash);
        p.PinIterations = PinIterationCount;
        Save(list);
    }

    public static void ClearPin(ProfileList list, Profile p)
    {
        p.PinHash = p.PinSalt = "";
        p.PinIterations = 0;
        Save(list);
    }

    public static bool CheckPin(Profile p, string pin)
    {
        if (!p.HasPin) return true;
        try
        {
            byte[] salt = Convert.FromBase64String(p.PinSalt);
            byte[] want = Convert.FromBase64String(p.PinHash);
            byte[] got = Rfc2898DeriveBytes.Pbkdf2(pin ?? "", salt, Math.Max(p.PinIterations, 1), HashAlgorithmName.SHA256, want.Length);
            return CryptographicOperations.FixedTimeEquals(got, want);
        }
        catch { return false; }
    }

    /// <summary>
    /// "Forgot PIN": removes the PIN and, so nobody gets into someone else's things that way, signs that person out
    /// of everything saved in the app: Claude sign-in, saved signature, API key and email passwords.
    /// Settings, email accounts (without passwords) and recent files stay.
    /// </summary>
    public static void ResetForgottenPin(ProfileList list, Profile p)
    {
        if (LiveSessionProfileId() == p.Id) throw new InvalidOperationException($"{p.Name} is signed in right now. Sign out first.");
        TryDeleteDir(Path.Combine(LocalDirOf(p), "WebView2"));
        EditJson(Path.Combine(DataDirOf(p), "settings.json"), root => root["ProtectedApiKey"] = "");
        EditJson(Path.Combine(DataDirOf(p), "mail.json"), root =>
        {
            if (root["Accounts"] is JsonArray accounts)
                foreach (JsonNode? a in accounts)
                    if (a is JsonObject o) o["ProtectedPassword"] = "";
        });
        ClearPin(list, p);
    }

    private static void EditJson(string file, Action<JsonObject> edit)
    {
        if (!File.Exists(file)) return;
        if (JsonNode.Parse(File.ReadAllText(file)) is not JsonObject root) return;
        edit(root);
        File.WriteAllText(file, root.ToJsonString(FileJson));
    }

    // ------------------------------------------------------------------
    //  Signing in and out
    // ------------------------------------------------------------------

    private sealed class SessionInfo
    {
        public string ProfileId { get; set; } = "";
        public List<SessionProcess> Processes { get; set; } = new();
    }

    private sealed class SessionProcess
    {
        public int Pid { get; set; }
        public long StartedUtcTicks { get; set; }
    }

    /// <summary>
    /// Who is signed in, if a copy of the app is still open. Double-clicking a PDF while someone is signed in
    /// opens it as them without asking again; once every window is closed, the next start asks "Who's using?".
    /// </summary>
    public static string? LiveSessionProfileId()
    {
        var s = ReadSession();
        if (s == null) return null;
        int me = Environment.ProcessId;
        return s.Processes.Any(sp => sp.Pid != me && IsAlive(sp)) ? s.ProfileId : null;
    }

    /// <summary>Sign this copy of the app in as this person.</summary>
    public static void SignIn(ProfileList list, Profile p)
    {
        // Move out of the old shared folders, unless another open copy of the app is using them right now.
        if (LiveSessionProfileId() != p.Id) MoveToOwnFolder(list, p);
        p.LastUsed = DateTime.Now;
        try { Save(list); } catch { }
        Current = p;

        var s = ReadSession();
        if (s == null || s.ProfileId != p.Id || !s.Processes.Any(IsAlive))
            s = new SessionInfo { ProfileId = p.Id };
        s.Processes.RemoveAll(sp => !IsAlive(sp));
        s.Processes.Add(Me());
        WriteSession(s);
        ListenForSignOut();
    }

    /// <summary>This copy of the app is closing: take it off the session (others stay signed in).</summary>
    public static void LeaveSession()
    {
        if (Current == null) return;
        var s = ReadSession();
        if (s == null || s.ProfileId != Current.Id) return;
        int me = Environment.ProcessId;
        s.Processes.RemoveAll(sp => sp.Pid == me || !IsAlive(sp));
        if (s.Processes.Count == 0) TryDeleteFile(SessionFile);
        else WriteSession(s);
    }

    /// <summary>Signing out: tells every other open copy of the app to close too, and forgets the session.</summary>
    public static void EndSessionEverywhere()
    {
        var s = ReadSession();
        if (s != null)
        {
            int me = Environment.ProcessId;
            foreach (var sp in s.Processes.Where(sp => sp.Pid != me && IsAlive(sp)))
            {
                try
                {
                    if (EventWaitHandle.TryOpenExisting(SignOutEventName(sp.Pid), out var h))
                        using (h) h.Set();
                }
                catch { }
            }
        }
        TryDeleteFile(SessionFile);
    }

    /// <summary>Raised (on a background thread) when another copy of the app signs out.</summary>
    public static event Action? SignOutRequested;

    private static EventWaitHandle? _signOutEvent;

    private static void ListenForSignOut()
    {
        if (_signOutEvent != null) return;
        try
        {
            _signOutEvent = new EventWaitHandle(false, EventResetMode.AutoReset, SignOutEventName(Environment.ProcessId));
            var t = new Thread(() =>
            {
                while (true)
                {
                    _signOutEvent.WaitOne();
                    SignOutRequested?.Invoke();
                }
            }) { IsBackground = true, Name = "Sign-out listener" };
            t.Start();
        }
        catch { }
    }

    private static string SignOutEventName(int pid) => $"PdfAndMoore.SignOut.{pid}";

    private static SessionProcess Me()
    {
        using var p = Process.GetCurrentProcess();
        return new SessionProcess { Pid = p.Id, StartedUtcTicks = p.StartTime.ToUniversalTime().Ticks };
    }

    private static bool IsAlive(SessionProcess sp)
    {
        try
        {
            using var p = Process.GetProcessById(sp.Pid);
            if (p.HasExited) return false;
            // The same number can be reused by a new program later, so check it started at the same time.
            return Math.Abs(p.StartTime.ToUniversalTime().Ticks - sp.StartedUtcTicks) < TimeSpan.TicksPerSecond;
        }
        catch { return false; }
    }

    private static SessionInfo? ReadSession()
    {
        try { return File.Exists(SessionFile) ? JsonSerializer.Deserialize<SessionInfo>(File.ReadAllText(SessionFile)) : null; }
        catch { return null; }
    }

    private static void WriteSession(SessionInfo s)
    {
        try
        {
            Directory.CreateDirectory(LocalRoot);
            File.WriteAllText(SessionFile, JsonSerializer.Serialize(s));
        }
        catch { }
    }
}
