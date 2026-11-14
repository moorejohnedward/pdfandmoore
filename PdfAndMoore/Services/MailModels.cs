using System.Text.Json.Serialization;

namespace PdfAndMoore.Services;

// Mail tab (v9): data that is saved, and data sent to the web page.

/// <summary>A mailbox you sign in to with an app password (usually one Google account).</summary>
public sealed class MailAccount
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Email { get; set; } = "";
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#2BB3D9";
    public string ImapHost { get; set; } = "imap.gmail.com";
    public int ImapPort { get; set; } = 993;
    public string SmtpHost { get; set; } = "smtp.gmail.com";
    public int SmtpPort { get; set; } = 587;

    /// <summary>App password, encrypted with Windows DPAPI. Never sent to the web page.</summary>
    [JsonIgnore] public string ProtectedPassword { get; set; } = "";

    /// <summary>Every address this account can send as: the main address plus aliases.</summary>
    public List<SendIdentity> Identities { get; set; } = new();
}

/// <summary>An address you can send from (a main address or an alias), with its signature.</summary>
public sealed class SendIdentity
{
    public string Address { get; set; } = "";
    public string DisplayName { get; set; } = "John Moore";
    /// <summary>Business or role, e.g. "Kona Hydrostatic Testing".</summary>
    public string Business { get; set; } = "";
    /// <summary>Smart folder for mail sent TO this address.</summary>
    public string Folder { get; set; } = "Personal";
    /// <summary>Topics that mean "send from this address" (comma separated).</summary>
    public string Hints { get; set; } = "";
    public string Signature { get; set; } = "";
}

public sealed class SortRule
{
    public string Match { get; set; } = "";
    public string Folder { get; set; } = "";
}

public sealed class MailSettings
{
    /// <summary>Settings layout version (2 = v9.1: Gmail labels and categories sort mail).</summary>
    public int Version { get; set; } = 2;
    public List<MailAccount> Accounts { get; set; } = new();
    public List<string> Folders { get; set; } = new();
    public List<SortRule> Rules { get; set; } = new();
    public string AboutMe { get; set; } = "";
    public int FetchCount { get; set; } = 200;
    public bool AutoSort { get; set; } = true;
}

/// <summary>One email in the inbox list.</summary>
public sealed class MailSummary
{
    public string AccountId { get; set; } = "";
    /// <summary>The IMAP folder (Gmail label) the message was read from, e.g. "INBOX" or "Business/Square".</summary>
    public string Mailbox { get; set; } = "INBOX";
    public uint Uid { get; set; }
    public string MessageId { get; set; } = "";
    public List<string> References { get; set; } = new();
    public string FromName { get; set; } = "";
    public string FromAddress { get; set; } = "";
    public string To { get; set; } = "";
    public string Cc { get; set; } = "";
    public string Subject { get; set; } = "";
    /// <summary>Unix milliseconds, so JavaScript can make a Date from it.</summary>
    public long Date { get; set; }
    public string Preview { get; set; } = "";
    public bool Read { get; set; }
    public bool HasAttachments { get; set; }
    /// <summary>Gmail labels on the message (user labels only, e.g. "Business/Square").</summary>
    public List<string> Labels { get; set; } = new();
    /// <summary>Gmail inbox tab: "primary", "promotions", "social", "updates", "forums" or "" if unknown.</summary>
    public string Category { get; set; } = "";
    public bool Starred { get; set; }
}

/// <summary>One page of messages from a folder.</summary>
public sealed class MailPage
{
    public List<MailSummary> Messages { get; set; } = new();
    /// <summary>How many messages the folder holds on the server.</summary>
    public int Total { get; set; }
    public int Unread { get; set; }
}

/// <summary>A folder (Gmail label) in an account.</summary>
public sealed class MailFolderInfo
{
    public string Name { get; set; } = "";
    public string FullName { get; set; } = "";
    /// <summary>"inbox", "sent", "all", "starred", "important", "drafts", "spam", "trash" or "label".</summary>
    public string Kind { get; set; } = "label";
    public int Total { get; set; }
    public int Unread { get; set; }
}

public sealed class MailAttachmentInfo
{
    public int Index { get; set; }
    public string Name { get; set; } = "";
    public long Size { get; set; }
    public string ContentType { get; set; } = "";
}

public sealed class MailMessageBody
{
    public string Text { get; set; } = "";
    public string Html { get; set; } = "";
    public List<MailAttachmentInfo> Attachments { get; set; } = new();
}
