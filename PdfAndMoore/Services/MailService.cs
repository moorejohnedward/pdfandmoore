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
        IMailFolder folder = await ResolveFolderAsync(client, mailbox, ct);
        await folder.OpenAsync(access, ct);
        return folder;
    }

    /// <summary>
    /// Finds a folder by name. Besides real names ("INBOX", "Business/Square") it understands the special
    /// names "\\Drafts", "\\All", "\\Trash", "\\Sent" and "\\Junk", so the web page doesn't need to know that
    /// Gmail calls them "[Gmail]/Drafts" (or "[Google Mail]/Drafts" in some countries).
    /// </summary>
    private static async Task<IMailFolder> ResolveFolderAsync(ImapClient client, string? mailbox, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(mailbox) || mailbox.Equals("INBOX", StringComparison.OrdinalIgnoreCase) || mailbox.Equals("\\Inbox", StringComparison.OrdinalIgnoreCase))
            return client.Inbox;
        if (mailbox.StartsWith('\\'))
        {
            SpecialFolder? special = mailbox.ToLowerInvariant() switch
            {
                "\\drafts" => SpecialFolder.Drafts,
                "\\all" => SpecialFolder.All,
                "\\trash" => SpecialFolder.Trash,
                "\\sent" => SpecialFolder.Sent,
                "\\junk" => SpecialFolder.Junk,
                _ => null,
            };
            if (special is { } sf && (client.Capabilities & (ImapCapabilities.SpecialUse | ImapCapabilities.XList)) != 0 && client.GetFolder(sf) is { } found)
                return found;
            throw new InvalidOperationException($"This mail server has no {mailbox.TrimStart('\\')} folder.");
        }
        return await client.GetFolderAsync(mailbox, ct);
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
            bool drafts = (folder.Attributes & FolderAttributes.Drafts) != 0;
            foreach (var s in summaries) page.Messages.Add(ToSummary(a, folder.FullName, s, drafts));

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

        // Mail you send to yourself never reaches Gmail's Inbox: Gmail files it under Sent only.
        // That's what a scanner does when it signs in as you to "scan to email" you (and notes to self).
        // Show the last two weeks of it with the inbox so scans don't go missing (v9.5.2).
        if (IsGmail(client) && folder == client.Inbox && skip <= 0)
            page.Messages.AddRange(await SentToSelfAsync(client, a, ct));

        await client.DisconnectAsync(true, ct);
        return page;
    }

    /// <summary>
    /// Recent messages from this account to itself that aren't in the inbox (Gmail keeps them in Sent only).
    /// Read from All Mail, so opening, deleting and labeling them works like any other message.
    /// </summary>
    private static async Task<List<MailSummary>> SentToSelfAsync(ImapClient client, MailAccount a, CancellationToken ct)
    {
        var list = new List<MailSummary>();
        try
        {
            var all = await ResolveFolderAsync(client, "\\All", ct);
            await all.OpenAsync(FolderAccess.ReadOnly, ct);
            var hits = await all.SearchAsync(SearchQuery.GMailRawSearch("from:me to:me -in:inbox -in:drafts -in:trash -in:spam newer_than:14d"), ct);
            var newest = hits.OrderByDescending(u => u.Id).Take(25).ToList();
            if (newest.Count == 0) return list;
            foreach (var s in await all.FetchAsync(newest, SummaryRequest(true), ct))
            {
                var m = ToSummary(a, all.FullName, s);
                m.ToSelf = true;
                m.Category = "primary";
                list.Add(m);
            }
        }
        catch (Exception ex) when (ex is ImapCommandException or InvalidOperationException or FolderNotFoundException)
        {
            // No All Mail folder or search not supported: just show the inbox.
        }
        return list;
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

    private static MailSummary ToSummary(MailAccount a, string mailbox, IMessageSummary s, bool draftsFolder = false)
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
            Bcc = env?.Bcc?.ToString() ?? "",
            Subject = string.IsNullOrWhiteSpace(env?.Subject) ? "(no subject)" : env!.Subject!,
            Date = (env?.Date ?? DateTimeOffset.Now).ToUnixTimeMilliseconds(),
            Preview = (s.PreviewText ?? "").Trim(),
            Read = s.Flags.HasValue && s.Flags.Value.HasFlag(MessageFlags.Seen),
            Starred = s.Flags.HasValue && s.Flags.Value.HasFlag(MessageFlags.Flagged),
            HasAttachments = s.Attachments?.Any() == true,
            // System labels look like "\\Important"; keep only the user's own labels.
            Labels = labels.Where(l => !l.StartsWith('\\')).ToList(),
            Bulk = IsBulk(s.Headers),
            Draft = draftsFolder || (s.Flags.HasValue && s.Flags.Value.HasFlag(MessageFlags.Draft)),
            InInbox = labels.Contains("\\Inbox") || mailbox.Equals("INBOX", StringComparison.OrdinalIgnoreCase),
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
        // Nested labels like "Business/Square": make each level that doesn't exist yet.
        IMailFolder parent = client.GetFolder(ns);
        char sep = ns.DirectorySeparator == '\0' ? '/' : ns.DirectorySeparator;
        string path = "";
        foreach (string part in name.Split(sep, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            path = path.Length == 0 ? part : path + sep + part;
            try { parent = await client.GetFolderAsync(path, ct); }
            catch (FolderNotFoundException)
            {
                parent = await parent.CreateAsync(part, true, ct) ?? throw new InvalidOperationException($"Couldn't make the \"{name}\" label.");
            }
        }
        return parent;
    }

    /// <summary>
    /// Downloads one message, returns its text/HTML and attachment list, and marks it read
    /// (unless peek is true: Claude's mail assistant reads without changing anything).
    /// </summary>
    public async Task<MailMessageBody> GetMessageAsync(MailAccount a, string? mailbox, uint uid, bool peek = false, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var folder = await OpenFolderAsync(client, mailbox, peek ? FolderAccess.ReadOnly : FolderAccess.ReadWrite, ct);
        var id = new UniqueId(uid);
        var message = await folder.GetMessageAsync(id, ct);
        if (!peek) await folder.AddFlagsAsync(id, MessageFlags.Seen, true, ct);
        await client.DisconnectAsync(true, ct);

        return new MailMessageBody
        {
            Text = message.TextBody ?? "",
            Html = message.HtmlBody ?? "",
            Subject = message.Subject ?? "",
            From = message.From.Mailboxes.FirstOrDefault()?.Address ?? "",
            To = message.To.ToString(),
            Cc = message.Cc.ToString(),
            Bcc = message.Bcc.ToString(),
            InReplyTo = message.InReplyTo ?? "",
            References = message.References.ToList(),
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
        var message = BuildMessage(from, to, cc, bcc, subject, body, attachments, inReplyTo, references);
        if (message.To.Count + message.Cc.Count + message.Bcc.Count == 0)
            throw new InvalidOperationException("Add at least one person to send to.");

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

    private static MimeMessage BuildMessage(SendIdentity from, string to, string cc, string bcc, string subject,
        string body, IEnumerable<OutgoingAttachment> attachments, string? inReplyTo, IEnumerable<string>? references)
    {
        var message = new MimeMessage();
        message.From.Add(new MailboxAddress(from.DisplayName, from.Address));
        AddAddresses(message.To, to);
        AddAddresses(message.Cc, cc);
        AddAddresses(message.Bcc, bcc);
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
        return message;
    }

    // ------------------------------------------------------------------
    // Drafts (v9.3): saved in the account's own Drafts folder, so Gmail on the web and phone sees them too.
    // ------------------------------------------------------------------

    /// <summary>
    /// Saves a draft in the account's Drafts folder and returns its new ID there.
    /// replaceUid = the draft's previous ID: Gmail keeps one copy per save, so the old one is removed.
    /// </summary>
    public async Task<uint?> SaveDraftAsync(MailAccount a, SendIdentity from, string to, string cc, string bcc, string subject,
        string body, IEnumerable<OutgoingAttachment> attachments, string? inReplyTo, IEnumerable<string>? references,
        uint? replaceUid, CancellationToken ct = default)
    {
        var message = BuildMessage(from, to, cc, bcc, subject, body, attachments, inReplyTo, references);
        using var client = await OpenImapAsync(a, ct);
        var drafts = await ResolveFolderAsync(client, "\\Drafts", ct);
        UniqueId? saved = await drafts.AppendAsync(new AppendRequest(message, MessageFlags.Draft | MessageFlags.Seen), ct);
        if (replaceUid is { } old && old != 0 && (saved == null || saved.Value.Id != old))
            await RemoveFromFolderAsync(drafts, new[] { new UniqueId(old) }, ct);
        await client.DisconnectAsync(true, ct);
        return saved?.Id;
    }

    /// <summary>Removes a draft (after it is sent, or when you press Discard).</summary>
    public async Task DeleteDraftAsync(MailAccount a, uint uid, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var drafts = await ResolveFolderAsync(client, "\\Drafts", ct);
        await RemoveFromFolderAsync(drafts, new[] { new UniqueId(uid) }, ct);
        await client.DisconnectAsync(true, ct);
    }

    private static async Task RemoveFromFolderAsync(IMailFolder folder, IList<UniqueId> uids, CancellationToken ct)
    {
        if (!folder.IsOpen || folder.Access != FolderAccess.ReadWrite) await folder.OpenAsync(FolderAccess.ReadWrite, ct);
        await folder.AddFlagsAsync(uids, MessageFlags.Deleted, true, ct);
        await folder.ExpungeAsync(uids, ct);
    }

    // ------------------------------------------------------------------
    // Changing mail (v9.3): labels, archive, read/unread, star, trash. Used by Claude's mail assistant.
    // Everything works on Gmail labels, so nothing is lost and every change can be undone.
    // ------------------------------------------------------------------

    /// <summary>
    /// Changes messages in one folder (normally "\\All", All Mail). Returns what was done so it can be undone:
    /// for Trash, the messages' new IDs in the Trash folder.
    /// </summary>
    public async Task<MailChangeResult> ModifyAsync(MailAccount a, string? mailbox, IList<uint> uidList, MailChange change, CancellationToken ct = default)
    {
        var result = new MailChangeResult { AccountId = a.Id, Count = uidList.Count };
        if (uidList.Count == 0) return result;
        using var client = await OpenImapAsync(a, ct);
        var folder = await OpenFolderAsync(client, mailbox, FolderAccess.ReadWrite, ct);
        result.Mailbox = folder.FullName;
        result.Uids = uidList.ToList();
        await ApplyAsync(client, folder, uidList.Select(u => new UniqueId(u)).ToList(), change, result, ct);
        await client.DisconnectAsync(true, ct);
        return result;
    }

    /// <summary>
    /// Changes every message that matches a Gmail search (e.g. "category:promotions older_than:30d"),
    /// newest first, up to max. Works in All Mail so the IDs stay the same for Undo.
    /// </summary>
    public async Task<MailChangeResult> ModifyMatchingAsync(MailAccount a, string query, MailChange change, int max, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        if (!IsGmail(client)) throw new InvalidOperationException($"{a.Email}: changing mail by search only works with Gmail accounts.");
        var folder = await OpenFolderAsync(client, "\\All", FolderAccess.ReadWrite, ct);
        var found = await folder.SearchAsync(SearchQuery.GMailRawSearch(query), ct);
        var uids = found.OrderByDescending(u => u.Id).Take(Math.Max(1, max)).ToList();
        var result = new MailChangeResult { AccountId = a.Id, Mailbox = folder.FullName, Total = found.Count, Count = uids.Count, Uids = uids.Select(u => u.Id).ToList() };
        if (uids.Count > 0) await ApplyAsync(client, folder, uids, change, result, ct);
        await client.DisconnectAsync(true, ct);
        return result;
    }

    private static async Task ApplyAsync(ImapClient client, IMailFolder folder, IList<UniqueId> uids, MailChange change, MailChangeResult result, CancellationToken ct)
    {
        bool gmail = IsGmail(client);
        var add = change.AddLabels.Where(l => !string.IsNullOrWhiteSpace(l)).Select(l => l.Trim()).Distinct().ToList();
        var remove = change.RemoveLabels.Where(l => !string.IsNullOrWhiteSpace(l)).Select(l => l.Trim()).Distinct().ToList();
        if (change.Archive) remove.Add("\\Inbox");
        if (change.ToInbox) add.Add("\\Inbox");

        if ((add.Count > 0 || remove.Count > 0) && !gmail)
            throw new InvalidOperationException("Labels and archiving only work with Gmail accounts.");

        // Make any new labels first (Gmail labels are folders over IMAP).
        foreach (var label in add.Where(l => !l.StartsWith('\\')))
            await GetOrCreateFolderAsync(client, label, ct);

        if (add.Count > 0) await folder.AddLabelsAsync(uids, add, true, ct);
        if (remove.Count > 0) await folder.RemoveLabelsAsync(uids, remove, true, ct);

        if (change.Read == true) await folder.AddFlagsAsync(uids, MessageFlags.Seen, true, ct);
        if (change.Read == false) await folder.RemoveFlagsAsync(uids, MessageFlags.Seen, true, ct);
        if (change.Starred == true) await folder.AddFlagsAsync(uids, MessageFlags.Flagged, true, ct);
        if (change.Starred == false) await folder.RemoveFlagsAsync(uids, MessageFlags.Flagged, true, ct);

        if (change.Trash)
        {
            // Gmail keeps Trash for 30 days, so this can be undone.
            var trash = await ResolveFolderAsync(client, "\\Trash", ct);
            var map = await folder.MoveToAsync(uids, trash, ct);
            result.TrashMailbox = trash.FullName;
            result.TrashUids = map.Destination.Select(u => u.Id).ToList();
        }
        else if (change.Spam)
        {
            // Report spam (v9.5): Gmail learns from mail moved into Spam. TrashMailbox/TrashUids say where it went, for Undo.
            var junk = await ResolveFolderAsync(client, "\\Junk", ct);
            var map = await folder.MoveToAsync(uids, junk, ct);
            result.TrashMailbox = junk.FullName;
            result.TrashUids = map.Destination.Select(u => u.Id).ToList();
        }
        else if (change.DeleteForever)
        {
            // Delete for good (v9.5): only from Trash or Spam, so a slip can never wipe mail straight out of the inbox.
            var trash = await ResolveFolderAsync(client, "\\Trash", ct);
            IMailFolder? junk = null;
            try { junk = await ResolveFolderAsync(client, "\\Junk", ct); } catch (InvalidOperationException) { }
            bool allowed = folder.FullName == trash.FullName || (junk != null && folder.FullName == junk.FullName);
            if (!allowed) throw new InvalidOperationException("Emails can only be deleted for good from Trash or Spam.");
            await folder.AddFlagsAsync(uids, MessageFlags.Deleted, true, ct);
            await folder.ExpungeAsync(uids, ct);
        }
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
