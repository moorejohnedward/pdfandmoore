using System.Net;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
using MailKit.Search;
using MailKit.Security;
using MimeKit;

namespace PdfAndMoore.Services;

/// <summary>
/// Reads mail over IMAP and sends over SMTP (MailKit), signing in with each account's app password.
/// Works with Gmail and Google Workspace out of the box; other providers just need their server names.
/// </summary>
public sealed class MailService
{
    private static async Task<ImapClient> OpenImapAsync(MailAccount a, CancellationToken ct)
    {
        var client = new ImapClient();
        try
        {
            await client.ConnectAsync(a.ImapHost, a.ImapPort, SecureSocketOptions.SslOnConnect, ct);
            await client.AuthenticateAsync(a.Email, MailSettingsStore.PasswordFor(a), ct);
            return client;
        }
        catch (AuthenticationException)
        {
            client.Dispose();
            throw new InvalidOperationException($"{a.Email}: Google didn't accept the app password. Make a new one and paste it in Settings › Email accounts.");
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    private static readonly string[] Categories = { "promotions", "social", "updates", "forums" };

    private static async Task<IMailFolder> OpenFolderAsync(ImapClient client, string? mailbox, FolderAccess access, CancellationToken ct)
    {
        IMailFolder folder = string.IsNullOrEmpty(mailbox) || mailbox.Equals("INBOX", StringComparison.OrdinalIgnoreCase)
            ? client.Inbox
            : await client.GetFolderAsync(mailbox, ct);
        await folder.OpenAsync(access, ct);
        return folder;
    }

    private static bool IsGmail(ImapClient client) => (client.Capabilities & ImapCapabilities.GMailExt1) != 0;

    // Headers that mark mass mailings (newsletters, marketing, loan offers sent in bulk).
    private static readonly string[] BulkHeaders = { "List-Unsubscribe", "List-Id", "Precedence" };

    private static FetchRequest SummaryRequest(bool gmail)
    {
        var items = MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.Flags |
                    MessageSummaryItems.PreviewText | MessageSummaryItems.References | MessageSummaryItems.BodyStructure;
        if (gmail) items |= MessageSummaryItems.GMailLabels;
        return new FetchRequest(items, BulkHeaders);
    }

    /// <summary>
    /// Reads one page of a folder, newest first. skip = how many of the newest messages were already loaded
    /// (for "Load older"). On Gmail, each message also gets its labels and its inbox tab (Primary, Promotions…).
    /// </summary>
    public async Task<MailPage> FetchAsync(MailAccount a, string? mailbox, int count, int skip, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var folder = await OpenFolderAsync(client, mailbox, FolderAccess.ReadOnly, ct);
        var page = new MailPage { Total = folder.Count, Unread = folder.Unread };

        int end = folder.Count - 1 - Math.Max(0, skip);
        if (end >= 0)
        {
            int start = Math.Max(0, end - count + 1);
            bool gmail = IsGmail(client);
            var summaries = await folder.FetchAsync(start, end, SummaryRequest(gmail), ct);
            foreach (var s in summaries) page.Messages.Add(ToSummary(a, folder.FullName, s));

            // Gmail's tabs aren't labels over IMAP, so ask Gmail which of these messages are in each tab.
            if (gmail && folder == client.Inbox && page.Messages.Count > 0)
            {
                var uids = summaries.Select(x => x.UniqueId).ToList();
                var byUid = page.Messages.ToDictionary(m => m.Uid);
                foreach (var cat in Categories)
                {
                    try
                    {
                        var hits = await folder.SearchAsync(SearchQuery.Uids(uids).And(SearchQuery.GMailRawSearch("category:" + cat)), ct);
                        foreach (var uid in hits)
                            if (byUid.TryGetValue(uid.Id, out var m)) m.Category = cat;
                    }
                    catch (ImapCommandException) { /* not supported for this account: skip tabs */ }
                }
                foreach (var m in page.Messages) if (m.Category.Length == 0) m.Category = "primary";
            }
        }
        await client.DisconnectAsync(true, ct);
        return page;
    }

    /// <summary>Lists the account's folders (Gmail labels) with message and unread counts.</summary>
    public async Task<List<MailFolderInfo>> ListFoldersAsync(MailAccount a, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var list = new List<MailFolderInfo>();
        var ns = client.PersonalNamespaces.FirstOrDefault() ?? throw new InvalidOperationException("This mail server didn't list any folders.");
        var folders = await client.GetFoldersAsync(ns, StatusItems.Count | StatusItems.Unread, false, ct);
        foreach (var f in folders)
        {
            if ((f.Attributes & (FolderAttributes.NoSelect | FolderAttributes.NonExistent)) != 0) continue;
            string kind =
                f.FullName.Equals("INBOX", StringComparison.OrdinalIgnoreCase) ? "inbox" :
                (f.Attributes & FolderAttributes.Sent) != 0 ? "sent" :
                (f.Attributes & FolderAttributes.All) != 0 ? "all" :
                (f.Attributes & FolderAttributes.Flagged) != 0 ? "starred" :
                (f.Attributes & FolderAttributes.Important) != 0 ? "important" :
                (f.Attributes & FolderAttributes.Drafts) != 0 ? "drafts" :
                (f.Attributes & FolderAttributes.Junk) != 0 ? "spam" :
                (f.Attributes & FolderAttributes.Trash) != 0 ? "trash" : "label";
            list.Add(new MailFolderInfo { Name = f.Name, FullName = f.FullName, Kind = kind, Total = f.Count, Unread = f.Unread });
        }
        await client.DisconnectAsync(true, ct);
        return list;
    }

    /// <summary>Searches the whole mailbox (Gmail search words work, e.g. "from:tim has:attachment"). Newest first.</summary>
    public async Task<MailPage> SearchAsync(MailAccount a, string query, int max, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        bool gmail = IsGmail(client);
        IMailFolder folder = client.Inbox;
        if ((client.Capabilities & (ImapCapabilities.SpecialUse | ImapCapabilities.XList)) != 0 && client.GetFolder(SpecialFolder.All) is { } all)
            folder = all;
        await folder.OpenAsync(FolderAccess.ReadOnly, ct);

        SearchQuery q = gmail
            ? SearchQuery.GMailRawSearch(query)
            : SearchQuery.SubjectContains(query).Or(SearchQuery.FromContains(query)).Or(SearchQuery.BodyContains(query));
        var uids = await folder.SearchAsync(q, ct);
        var page = new MailPage { Total = uids.Count };
        var newest = uids.OrderByDescending(u => u.Id).Take(max).ToList();
        if (newest.Count > 0)
        {
            foreach (var s in await folder.FetchAsync(newest, SummaryRequest(gmail), ct)) page.Messages.Add(ToSummary(a, folder.FullName, s));
        }
        await client.DisconnectAsync(true, ct);
        return page;
    }

    private static MailSummary ToSummary(MailAccount a, string mailbox, IMessageSummary s)
    {
        var env = s.Envelope;
        var from = env?.From?.Mailboxes.FirstOrDefault();
        var labels = s.GMailLabels ?? (IList<string>)Array.Empty<string>();
        return new MailSummary
        {
            AccountId = a.Id,
            Mailbox = mailbox,
            Uid = s.UniqueId.Id,
            MessageId = env?.MessageId ?? "",
            References = s.References?.ToList() ?? new List<string>(),
            FromName = from?.Name ?? "",
            FromAddress = from?.Address ?? "",
            To = env?.To?.ToString() ?? "",
            Cc = env?.Cc?.ToString() ?? "",
            Subject = string.IsNullOrWhiteSpace(env?.Subject) ? "(no subject)" : env!.Subject!,
            Date = (env?.Date ?? DateTimeOffset.Now).ToUnixTimeMilliseconds(),
            Preview = (s.PreviewText ?? "").Trim(),
            Read = s.Flags.HasValue && s.Flags.Value.HasFlag(MessageFlags.Seen),
            Starred = s.Flags.HasValue && s.Flags.Value.HasFlag(MessageFlags.Flagged),
            HasAttachments = s.Attachments?.Any() == true,
            // System labels look like "\\Important"; keep only the user's own labels.
            Labels = labels.Where(l => !l.StartsWith('\\')).ToList(),
            Bulk = IsBulk(s.Headers),
        };
    }

    private static bool IsBulk(HeaderList? headers)
    {
        if (headers == null) return false;
        if (headers.Contains("List-Unsubscribe") || headers.Contains("List-Id")) return true;
        var precedence = headers["Precedence"]?.Trim().ToLowerInvariant();
        return precedence is "bulk" or "list" or "junk";
    }

    /// <summary>
    /// Clean up: moves messages out of a folder (normally the inbox) into a label, e.g. "Clutter".
    /// On Gmail that's the same as archiving with a label: nothing is deleted, and the mail stays
    /// in All Mail and under the label. Returns the messages' new IDs in the label (for Undo).
    /// </summary>
    public async Task<List<uint>> MoveToLabelAsync(MailAccount a, string? mailbox, IList<uint> uids, string label, CancellationToken ct = default)
    {
        if (uids.Count == 0) return new List<uint>();
        using var client = await OpenImapAsync(a, ct);
        var target = await GetOrCreateFolderAsync(client, label, ct);
        var source = await OpenFolderAsync(client, mailbox, FolderAccess.ReadWrite, ct);
        var map = await source.MoveToAsync(uids.Select(u => new UniqueId(u)).ToList(), target, ct);
        await client.DisconnectAsync(true, ct);
        return map.Destination.Select(u => u.Id).ToList();
    }

    /// <summary>Undo for clean up: moves messages from a label back into the inbox.</summary>
    public async Task<int> MoveBackToInboxAsync(MailAccount a, string label, IList<uint> uids, CancellationToken ct = default)
    {
        if (uids.Count == 0) return 0;
        using var client = await OpenImapAsync(a, ct);
        var source = await OpenFolderAsync(client, label, FolderAccess.ReadWrite, ct);
        var map = await source.MoveToAsync(uids.Select(u => new UniqueId(u)).ToList(), client.Inbox, ct);
        await client.DisconnectAsync(true, ct);
        return Math.Max(map.Destination.Count, uids.Count);
    }

    private static async Task<IMailFolder> GetOrCreateFolderAsync(ImapClient client, string name, CancellationToken ct)
    {
        try { return await client.GetFolderAsync(name, ct); }
        catch (FolderNotFoundException) { }
        var ns = client.PersonalNamespaces.FirstOrDefault() ?? throw new InvalidOperationException("This mail server didn't list any folders.");
        var root = client.GetFolder(ns);
        return await root.CreateAsync(name, true, ct) ?? throw new InvalidOperationException($"Couldn't make the \"{name}\" label.");
    }

    /// <summary>Downloads one message, returns its text/HTML and attachment list, and marks it read.</summary>
    public async Task<MailMessageBody> GetMessageAsync(MailAccount a, string? mailbox, uint uid, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var folder = await OpenFolderAsync(client, mailbox, FolderAccess.ReadWrite, ct);
        var id = new UniqueId(uid);
        var message = await folder.GetMessageAsync(id, ct);
        await folder.AddFlagsAsync(id, MessageFlags.Seen, true, ct);
        await client.DisconnectAsync(true, ct);

        return new MailMessageBody
        {
            Text = message.TextBody ?? "",
            Html = message.HtmlBody ?? "",
            Attachments = message.Attachments.Select((part, i) => new MailAttachmentInfo
            {
                Index = i,
                Name = part.ContentDisposition?.FileName ?? part.ContentType.Name ?? $"attachment-{i + 1}",
                ContentType = part.ContentType.MimeType,
                Size = part is MimePart mp && mp.Content != null ? EstimateSize(mp) : 0,
            }).ToList(),
        };
    }

    /// <summary>Returns one attachment's bytes (to open it in PDF and Moore or save it).</summary>
    public async Task<(string Name, byte[] Bytes)> GetAttachmentAsync(MailAccount a, string? mailbox, uint uid, int index, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var folder = await OpenFolderAsync(client, mailbox, FolderAccess.ReadOnly, ct);
        var message = await folder.GetMessageAsync(new UniqueId(uid), ct);
        await client.DisconnectAsync(true, ct);

        var part = message.Attachments.ElementAtOrDefault(index) ?? throw new InvalidOperationException("That attachment wasn't found.");
        string name = part.ContentDisposition?.FileName ?? part.ContentType.Name ?? $"attachment-{index + 1}";
        using var ms = new MemoryStream();
        if (part is MessagePart rfc822 && rfc822.Message != null) await rfc822.Message.WriteToAsync(ms, ct);
        else if (part is MimePart mp && mp.Content != null) await mp.Content.DecodeToAsync(ms, ct);
        return (name, ms.ToArray());
    }

    public sealed record OutgoingAttachment(string Name, byte[] Bytes);

    public async Task SendAsync(MailAccount a, SendIdentity from, string to, string cc, string bcc, string subject,
        string body, IEnumerable<OutgoingAttachment> attachments, string? inReplyTo, IEnumerable<string>? references,
        CancellationToken ct = default)
    {
        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(from.DisplayName, from.Address));
        AddAddresses(message.To, to);
        AddAddresses(message.Cc, cc);
        AddAddresses(message.Bcc, bcc);
        if (message.To.Count + message.Cc.Count + message.Bcc.Count == 0)
            throw new InvalidOperationException("Add at least one person to send to.");
        message.Subject = subject;

        if (!string.IsNullOrEmpty(inReplyTo))
        {
            message.InReplyTo = inReplyTo;
            foreach (var r in references ?? Enumerable.Empty<string>()) message.References.Add(r);
            message.References.Add(inReplyTo);
        }

        var builder = new BodyBuilder { TextBody = body, HtmlBody = TextToHtml(body) };
        foreach (var att in attachments) builder.Attachments.Add(att.Name, att.Bytes);
        message.Body = builder.ToMessageBody();

        using var smtp = new SmtpClient();
        await smtp.ConnectAsync(a.SmtpHost, a.SmtpPort, SecureSocketOptions.StartTls, ct);
        try
        {
            await smtp.AuthenticateAsync(a.Email, MailSettingsStore.PasswordFor(a), ct);
        }
        catch (AuthenticationException)
        {
            throw new InvalidOperationException($"{a.Email}: Google didn't accept the app password, so nothing was sent.");
        }
        await smtp.SendAsync(message, ct);
        await smtp.DisconnectAsync(true, ct);
    }

    /// <summary>Signs in for reading and sending, to check an account's settings.</summary>
    public async Task TestAsync(MailAccount a, CancellationToken ct = default)
    {
        using (var imap = await OpenImapAsync(a, ct))
            await imap.DisconnectAsync(true, ct);

        using var smtp = new SmtpClient();
        await smtp.ConnectAsync(a.SmtpHost, a.SmtpPort, SecureSocketOptions.StartTls, ct);
        await smtp.AuthenticateAsync(a.Email, MailSettingsStore.PasswordFor(a), ct);
        await smtp.DisconnectAsync(true, ct);
    }

    private static long EstimateSize(MimePart part)
    {
        try
        {
            if (part.Content == null) return 0;
            using var ms = new MemoryStream();
            part.Content.DecodeTo(ms);
            return ms.Length;
        }
        catch { return 0; }
    }

    private static void AddAddresses(InternetAddressList list, string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        foreach (var piece in text.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!InternetAddress.TryParse(piece, out var address))
                throw new FormatException($"\"{piece}\" doesn't look like an email address.");
            list.Add(address);
        }
    }

    private static string TextToHtml(string text)
    {
        string encoded = WebUtility.HtmlEncode(text).Replace("\r\n", "\n").Replace("\n", "<br>\n");
        return "<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1F2933\">" + encoded + "</div>";
    }
}
