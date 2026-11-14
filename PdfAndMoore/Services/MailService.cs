using System.Net;
using MailKit;
using MailKit.Net.Imap;
using MailKit.Net.Smtp;
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

    public async Task<List<MailSummary>> FetchInboxAsync(MailAccount a, int count, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly, ct);

        var list = new List<MailSummary>();
        if (inbox.Count > 0)
        {
            int start = Math.Max(0, inbox.Count - count);
            var items = MessageSummaryItems.UniqueId | MessageSummaryItems.Envelope | MessageSummaryItems.Flags |
                        MessageSummaryItems.PreviewText | MessageSummaryItems.References | MessageSummaryItems.BodyStructure;
            foreach (var s in await inbox.FetchAsync(start, -1, items, ct))
            {
                var env = s.Envelope;
                var from = env?.From?.Mailboxes.FirstOrDefault();
                list.Add(new MailSummary
                {
                    AccountId = a.Id,
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
                    HasAttachments = s.Attachments?.Any() == true,
                });
            }
        }
        await client.DisconnectAsync(true, ct);
        return list;
    }

    /// <summary>Downloads one message, returns its text/HTML and attachment list, and marks it read.</summary>
    public async Task<MailMessageBody> GetMessageAsync(MailAccount a, uint uid, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadWrite, ct);
        var id = new UniqueId(uid);
        var message = await inbox.GetMessageAsync(id, ct);
        await inbox.AddFlagsAsync(id, MessageFlags.Seen, true, ct);
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
    public async Task<(string Name, byte[] Bytes)> GetAttachmentAsync(MailAccount a, uint uid, int index, CancellationToken ct = default)
    {
        using var client = await OpenImapAsync(a, ct);
        var inbox = client.Inbox;
        await inbox.OpenAsync(FolderAccess.ReadOnly, ct);
        var message = await inbox.GetMessageAsync(new UniqueId(uid), ct);
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
