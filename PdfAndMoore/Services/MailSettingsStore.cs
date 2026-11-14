using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PdfAndMoore.Services;

/// <summary>
/// Saves mail accounts to %APPDATA%\PdfAndMoore\mail.json.
/// App passwords are encrypted with Windows DPAPI and are never sent to the web page;
/// the page only learns whether each account has one ("hasPassword").
/// </summary>
public sealed class MailSettingsStore
{
    private static readonly string Folder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfAndMoore");

    private static readonly string FilePath = Path.Combine(Folder, "mail.json");

    private static readonly JsonSerializerOptions FileJson = new() { WriteIndented = true };

    // On disk, each account also keeps its encrypted password.
    private sealed class StoredAccount
    {
        public MailAccount Account { get; set; } = new();
        public string ProtectedPassword { get; set; } = "";
    }

    private sealed class StoredFile
    {
        public int Version { get; set; }
        public List<StoredAccount> Accounts { get; set; } = new();
        public List<string> Folders { get; set; } = new();
        public List<SortRule> Rules { get; set; } = new();
        public string AboutMe { get; set; } = "";
        public int FetchCount { get; set; } = 50;
        public bool AutoSort { get; set; } = true;
    }

    public MailSettings Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return Defaults();
            var stored = JsonSerializer.Deserialize<StoredFile>(File.ReadAllText(FilePath)) ?? new StoredFile();
            var settings = new MailSettings
            {
                Version = stored.Version,
                Accounts = stored.Accounts.Select(s => { s.Account.ProtectedPassword = s.ProtectedPassword; return s.Account; }).ToList(),
                Folders = stored.Folders.Count > 0 ? stored.Folders : Defaults().Folders,
                Rules = stored.Rules,
                AboutMe = stored.AboutMe,
                FetchCount = stored.FetchCount <= 0 ? 200 : stored.FetchCount,
                AutoSort = stored.AutoSort,
            };
            if (settings.Version < 2) Upgrade(settings);
            return settings;
        }
        catch
        {
            // A damaged file should never stop the app; keep a copy so nothing is lost.
            try { File.Copy(FilePath, FilePath + ".bad", true); } catch { }
            return Defaults();
        }
    }

    /// <summary>
    /// v9.1: smart folders follow John's Gmail labels and tabs (School, VA &amp; Benefits, Diving, Finance,
    /// Promotions, Updates…). Keeps any folders and rules he added himself, then saves.
    /// </summary>
    private void Upgrade(MailSettings s)
    {
        var d = Defaults();
        var oldDefaults = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Newsletters" };
        s.Folders = d.Folders.Concat(s.Folders.Where(f => !oldDefaults.Contains(f) && !d.Folders.Contains(f, StringComparer.OrdinalIgnoreCase))).ToList();
        var defaultMatches = new HashSet<string>(d.Rules.Select(r => r.Match), StringComparer.OrdinalIgnoreCase) { "newsletter" };
        s.Rules = d.Rules.Concat(s.Rules.Where(r => !defaultMatches.Contains(r.Match))).ToList();
        if (s.FetchCount <= 50) s.FetchCount = 200;
        s.Version = 2;
        try { Save(s); } catch { }
    }

    public void Save(MailSettings s)
    {
        Directory.CreateDirectory(Folder);
        var stored = new StoredFile
        {
            Version = s.Version,
            Accounts = s.Accounts.Select(a => new StoredAccount { Account = a, ProtectedPassword = a.ProtectedPassword }).ToList(),
            Folders = s.Folders,
            Rules = s.Rules,
            AboutMe = s.AboutMe,
            FetchCount = s.FetchCount,
            AutoSort = s.AutoSort,
        };
        string temp = FilePath + ".saving";
        File.WriteAllText(temp, JsonSerializer.Serialize(stored, FileJson));
        File.Move(temp, FilePath, overwrite: true);
    }

    /// <summary>What the web page sees: everything except passwords, plus hasPassword per account.</summary>
    public static object ToClient(MailSettings s) => new
    {
        accounts = s.Accounts.Select(a => new
        {
            a.Id, a.Email, a.Name, a.Color, a.ImapHost, a.ImapPort, a.SmtpHost, a.SmtpPort, a.Identities,
            hasPassword = !string.IsNullOrEmpty(a.ProtectedPassword),
        }),
        s.Folders, s.Rules, s.AboutMe, s.FetchCount, s.AutoSort,
    };

    /// <summary>
    /// Applies settings sent from the web page. Passwords are kept from the saved copy unless the page
    /// sent a new one ("newPassword") for that account.
    /// </summary>
    public MailSettings FromClient(string json)
    {
        var current = Load();
        var node = JsonNode.Parse(json) as JsonObject ?? throw new ArgumentException("Bad mail settings.");
        var incoming = node.Deserialize<MailSettings>(HostBridge.JsonOptions) ?? new MailSettings();

        var accountsJson = node["accounts"] as JsonArray;
        for (int i = 0; i < incoming.Accounts.Count; i++)
        {
            var a = incoming.Accounts[i];
            if (string.IsNullOrWhiteSpace(a.Id)) a.Id = Guid.NewGuid().ToString("N");
            a.Email = a.Email.Trim();
            a.Identities = a.Identities.Where(x => !string.IsNullOrWhiteSpace(x.Address)).ToList();
            foreach (var id in a.Identities) id.Address = id.Address.Trim();

            string newPw = accountsJson?[i]?["newPassword"]?.GetValue<string>() ?? "";
            a.ProtectedPassword = newPw.Length > 0
                ? Protect(newPw.Replace(" ", ""))
                : current.Accounts.FirstOrDefault(c => c.Id == a.Id)?.ProtectedPassword ?? "";
        }
        incoming.Version = 2;
        incoming.Folders = incoming.Folders.Select(f => f.Trim()).Where(f => f.Length > 0).Distinct().ToList();
        incoming.Rules = incoming.Rules.Where(r => !string.IsNullOrWhiteSpace(r.Match) && !string.IsNullOrWhiteSpace(r.Folder)).ToList();
        if (incoming.FetchCount <= 0) incoming.FetchCount = 200;
        incoming.FetchCount = Math.Clamp(incoming.FetchCount, 10, 500);
        return incoming;
    }

    public static string PasswordFor(MailAccount a)
    {
        string pw = Unprotect(a.ProtectedPassword);
        if (string.IsNullOrEmpty(pw))
            throw new InvalidOperationException($"{a.Email} doesn't have an app password yet. Add it in Settings › Email accounts.");
        return pw;
    }

    private static string Protect(string plain)
    {
        if (string.IsNullOrEmpty(plain)) return "";
        return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(plain), null, DataProtectionScope.CurrentUser));
    }

    private static string Unprotect(string stored)
    {
        if (string.IsNullOrEmpty(stored)) return "";
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored), null, DataProtectionScope.CurrentUser)); }
        catch (CryptographicException) { return ""; }
    }

    /// <summary>First run: John's accounts, business aliases, signatures and sorting rules. All editable.</summary>
    public static MailSettings Defaults()
    {
        const string phone = "702-283-4536";
        return new MailSettings
        {
            Accounts =
            {
                new MailAccount
                {
                    Email = "john@divemoore.com", Name = "Business", Color = "#FF8A65",
                    Identities =
                    {
                        new SendIdentity
                        {
                            Address = "john@kona-hydrostatic-testing.com", Business = "Kona Hydrostatic Testing", Folder = "KHT",
                            Hints = "hydro, hydrostatic, cylinder, tank, sherwood, psi, pci, scba, hfd, fire, visual inspection, valve, distribution",
                            Signature = $"John Moore\nCo-Owner, Kona Hydrostatic Testing\nKailua-Kona, HI\n{phone}\njohn@kona-hydrostatic-testing.com\nkona-hydrostatic-testing.com",
                        },
                        new SendIdentity
                        {
                            Address = "john@divemoore.com", Business = "Dive Moore LLC", Folder = "Dive Moore",
                            Hints = "dive, diving, scuba, dan, padi, insurance, liability, dobor, permit, charter, honokohau, course, certification",
                            Signature = $"John Moore\nDive Moore LLC\nKailua-Kona, HI\n{phone}\njohn@divemoore.com\ndivemoore.com",
                        },
                        new SendIdentity
                        {
                            Address = "john@vintagescubamuseumofthepacific.com", Business = "Vintage Scuba Museum of the Pacific", Folder = "Museum",
                            Hints = "museum, vintage, antique, exhibit, display, donation, collection, history, artifact",
                            Signature = $"John Moore\nVintage Scuba Museum of the Pacific\nKailua-Kona, HI\n{phone}\njohn@vintagescubamuseumofthepacific.com",
                        },
                    },
                },
                new MailAccount
                {
                    Email = "moorejohnedward@gmail.com", Name = "Personal", Color = "#2BB3D9",
                    Identities =
                    {
                        new SendIdentity
                        {
                            Address = "moorejohnedward@gmail.com", Business = "Personal", Folder = "Personal",
                            Hints = "family, friends, personal, school, millersville, va",
                            Signature = $"John Moore\n{phone}",
                        },
                    },
                },
            },
            Folders = { "KHT", "Dive Moore", "Museum", "Business", "School", "VA & Benefits", "Diving", "Finance", "Travel", "Personal", "Promotions", "Updates", "Social", "fun" },
            // Order matters: first match wins. "label:" matches a Gmail label (and its sub-labels);
            // "category:" matches a Gmail inbox tab; anything else matches sender, recipients or subject.
            Rules =
            {
                new SortRule { Match = "kona-hydrostatic-testing", Folder = "KHT" },
                new SortRule { Match = "sherwood", Folder = "KHT" },
                new SortRule { Match = "psicylinders", Folder = "KHT" },
                new SortRule { Match = "psi-pci", Folder = "KHT" },
                new SortRule { Match = "ewing", Folder = "KHT" },
                new SortRule { Match = "divemoore", Folder = "Dive Moore" },
                new SortRule { Match = "vintagescubamuseum", Folder = "Museum" },
                new SortRule { Match = "label:Business", Folder = "Business" },
                new SortRule { Match = "label:Millersville", Folder = "School" },
                new SortRule { Match = "label:Colorado Technical University", Folder = "School" },
                new SortRule { Match = "label:VA", Folder = "VA & Benefits" },
                new SortRule { Match = "label:PADI", Folder = "Diving" },
                new SortRule { Match = "label:Finance", Folder = "Finance" },
                new SortRule { Match = "label:Travel", Folder = "Travel" },
                new SortRule { Match = "label:fun", Folder = "fun" },
                new SortRule { Match = "dan.org", Folder = "Business" },
                new SortRule { Match = "padi.com", Folder = "Business" },
                new SortRule { Match = "hawaiicounty.gov", Folder = "Business" },
                new SortRule { Match = "hawaii.gov", Folder = "Business" },
                new SortRule { Match = "squareup.com", Folder = "Business" },
                new SortRule { Match = "millersville", Folder = "School" },
                new SortRule { Match = "absorb", Folder = "School" },
                new SortRule { Match = "va.gov", Folder = "VA & Benefits" },
                new SortRule { Match = "category:promotions", Folder = "Promotions" },
                new SortRule { Match = "category:social", Folder = "Social" },
                new SortRule { Match = "category:updates", Folder = "Updates" },
                new SortRule { Match = "category:forums", Folder = "Updates" },
            },
            AboutMe =
                "I'm John Moore, based in Kailua-Kona on the Big Island of Hawaii. " +
                "I'm co-owner of Kona Hydrostatic Testing (KHT), a cylinder hydrostatic testing shop; we're Sherwood dealers with a large warehouse. " +
                "I also run Dive Moore LLC (scuba) and the Vintage Scuba Museum of the Pacific. " +
                "I'm a student in Millersville University's Applied AI Mastery program. " +
                "My emails are friendly but professional. Aloha and Mahalo are natural greetings and sign-offs for me. " +
                "Use American units and 24-hour (military) time, e.g. 1750.",
        };
    }
}
