# PDF and Moore — change log

A record of what was built and when (Hawaii time). Newest first.

## v9.9.0 — Monday, November 16, 2026
**Profiles: several people can share PDF and Moore, each with their own sign-in**
- **Who's using PDF and Moore?** A start-up screen with a big round initial for each person, like Chrome or Netflix profiles. It shows when more than one person is set up or anyone has a PIN; with just one person and no PIN, the app starts straight up like before.
- **Each person gets their own:** settings and look, Claude sign-in (claude.ai), Claude API key, email accounts and passwords, saved signature, recent files, backups, and on-device AI download.
- **Sign out (switch person):** click your round initial at the top right, or Tools › Sign out. Every window closes (asking about unsaved changes first), then *Who's using?* comes back. If the app is open twice (for example after double-clicking a PDF), both copies close.
- **Stays signed in while it's open:** double-clicking a PDF while someone is signed in opens it as them. Once every window is closed, the next start asks again.
- **PINs:** 4 to 8 numbers, optional, per person. Saved only as a salted PBKDF2-SHA256 hash (200,000 rounds), never the PIN itself. Five wrong tries locks it for 30 seconds. Changing or removing a PIN, renaming, or removing someone with a PIN needs their PIN.
- **Forgot PIN?** resets the PIN and, so nobody can use it to get into someone else's things, signs that person out of their Claude sign-in, saved signature, API key and email passwords. Their settings, email accounts and recent files stay.
- **Manage people** (Tools › Manage people…, or on *Who's using?*): add, rename, PINs, remove (deletes only what PDF and Moore saved for that person, never documents), and "ask every time, even with one person".
- Window titles show who is signed in (for example "Invoice.pdf - John") when more than one person is set up.
- New people start with a clean Mail tab (no accounts, everyday folders, Gmail's tabs sorted out of the inbox). John's own profile keeps his accounts, business addresses and rules.
- **Your existing data moves into the first profile automatically** the first time v9.9 starts (named from Settings or the Windows user name). If an older copy is still open and the move can't happen, nothing breaks: it keeps using the old folders and moves next time.
- Good to know: a PIN keeps people out of each other's things inside the app; separate Windows accounts are stronger. Digital IDs belong to the Windows account, so everyone on it shares them.
- New code: `Services/Profiles.cs` (folders, PIN hashing, session, sign-out signal between copies), `ProfileWindows.cs` (Who's using?, Manage people, name/PIN windows), Pam.* styles in `App.xaml`. Settings, mail, recent files, look & feel, WebView2 and backups now use the signed-in person's folder.

## v9.8.0 — Monday, November 16, 2026
**Linked to KonaSnap**
- KonaSnap 2.2 can now hand things to PDF and Moore:
  - **Text it grabbed → a new Word document or text file.** It opens as a new, unsaved file with the text already in it; Save asks where to put it. Paragraphs come across as paragraphs.
  - **A picture it couldn't read well → PDF and Moore's careful reader**, which straightens crooked or upside-down pictures and reads faded or unusual text, then shows the words to copy.
  - **A capture → a PDF** in the PDF editor, ready to sign, fill in, combine or email.
- PDF and Moore now lists itself with Windows each time it starts (the standard "App Paths" list for your account), so KonaSnap can find it wherever it's installed or built. Win+R › "PdfAndMoore" starts it too.
- New start-up options (used by KonaSnap): `--new-from <file> --as word|text` and `--read-text <picture>`.
- New code: `Services/AppLinks.cs`; the Word editor turns a .txt into a new document.

## v9.7.0 — Monday, November 16, 2026
**Make a new file of any kind from the start screen, and paste into it**
- **Create new** is now the first row on the start screen: **Word document**, **Spreadsheet**, **Presentation**, **Text file** and **Blank PDF**. Each one opens a fresh, empty file in its own window, ready to type or paste into. **Save** asks where to put it the first time.
- **Copy and paste works in all of them** (Ctrl+V, or right-click › Paste):
  - **Word document:** pasted text keeps its bold, lists and tables, from web pages, emails, other documents or PDFs.
  - **Spreadsheet:** a table copied from Excel, a web page or an email lands in the cells, one value per cell.
  - **Presentation:** pasted pictures become a picture on the slide, and (new) pasted text becomes a new text box when you're not already typing in one.
  - **Text file:** plain text exactly as copied. There's also a **Paste** button.
- **New text file editor** (like Notepad, in the app's look) for .txt, notes, lists, .md, .json, .xml, .ini, .yaml and scripts (.bat, .cmd, .ps1). Paste, Copy all, Wrap lines, Fixed width, bigger and smaller text (remembered), **Date & time** (F5) in military time, and a status line with line, column, word and character counts. It saves exactly what you type: Windows line endings for new files, and an existing file keeps its own line endings and encoding. **Save as** can use any name and extension. **Print** and **Open as PDF** work too.
- Text files you open (Open a file, drag and drop, or double-click) now open in the text editor so you can change them. To get one as PDF pages, press **Open as PDF** in its window.
- File › **New text file** joins New document, New spreadsheet and New presentation.
- New code: `wwwroot/office/text.html`; the "text" kind in `OfficeTypes.cs`; slide text paste in `office/slides.html`.

## v9.6.2 — Monday, November 16, 2026
**Sign lives in one place**
- The bold **Sign** button at the top of the window is now the only Sign button (plus Ctrl+Shift+G). Removed the extra ones: Home › Sign, the Sign a document start-screen tile, Edit › Signature, Protect › Quick sign, and the Insert › Signature… and Form › Sign this document… menu items.
- Unchanged: Forms › **Sign here** (adds an empty signature box for someone else to fill in) and Protect › **Sign with ID** (certificate signing). Those are different tools.

## v9.6.1 — Monday, November 16, 2026
**Sign is up front**
- **Sign** is now the first button in the top bar, in its own bold coral-to-pink color, ahead of Ask Claude, Print and Save.
- **Sign** is also the first button on the Home ribbon, and there's a **Sign a document** tile on the start screen, right after Open a file.
- With no document open, Sign asks you to pick the file, then goes straight to the signature window.
- Shortcut: **Ctrl+Shift+G**.

## v9.6.0 — Monday, November 16, 2026
**A Sign button, and sign on your phone with your stylus**
- **Sign button at the top of the window** (next to Print) whenever a document is open. It opens the signature window; pick a signature, then click where it goes on the page. It's a normal picture after that: drag it, resize it from the corner, or delete it.
- **Sign on my phone** tab in the signature window: it shows a QR code. Point your phone's camera at it, tap the link, and a full-screen white signing page opens on the phone. Sign above the line with your stylus (or finger) and tap **Done**. The signature shows up on the PC a second later; press **Use signature**.
  - Stylus pressure makes the line thicker and thinner like real ink, and once the pen touches the screen your palm resting on the glass is ignored. **Undo**, **Clear**, and dark-blue or black ink. Turn the phone sideways for more room.
  - Works when the phone is on the same Wi-Fi as the PC, or over **Tailscale** from anywhere (the window lists both addresses). Nothing goes through the internet or any outside service.
  - The link works once, for 15 minutes, and only while the signature window is open. The first time, Windows may ask to let PDF and Moore use the network: tick **Private networks** and press **Allow**.
- **From a picture** (was Upload): a photo of your signature on paper, or one drawn in any phone app, is cleaned up automatically. The paper and shadows are removed, the ink is kept and darkened a little, and it's cropped tight. Untick "Remove the paper background" to keep it as it is.
- **Use as signature** on picture attachments in Mail: draw your signature on the phone, email it to yourself, then save it as your signature with one click.
- **Draw here** now uses pen pressure too, when you sign with a pen on a touchscreen PC.
- The signature window remembers which way you signed last time and opens there; **Remember this signature** keeps it for **Use saved signature** next time.
- New code: `Services/PhoneSignService.cs` (a one-time, token-protected web server that runs only while the window is open), `Services/PhonePage.cs` (the phone's signing page), `phoneSign` in host.js, `cleanSignatureImage` / `useImageAsSignature` in forms.js. New library: qrcode-generator 1.4.4 by Kazuhiko Arase (MIT), `wwwroot/lib/qrcode.js`.

## v9.5.2 — Sunday, November 15, 2026
**Scans from the scanner show up in Mail**
- **Fixed:** an email the scanner sent to john@divemoore.com never appeared. When the scanner signs in as you and emails you ("scan to email"), the message is from you and to you, and Gmail files mail you send to yourself under **Sent only, never the Inbox**. Mail only read the Inbox, so the scan was invisible.
- Mail now also lists the last 2 weeks of mail you sent to yourself, in every Gmail account, with a blue **Sent to yourself** chip (scanner icon when there's an attachment). Open, Print, Delete, attachments and **Open** in the editor all work as usual. Notes to self show up the same way.
- "Load older" and "Showing the newest N" still count only the inbox.
- New code: `MailService.SentToSelfAsync` (Gmail search `from:me to:me -in:inbox newer_than:14d` in All Mail), `MailSummary.ToSelf`.

## v9.5.1 — Sunday, November 15, 2026
**Security fix: the Claude API key now stays on the Windows side only**
- Follows the course rule "the browser never sees the key." The app's screens are a web page inside WebView2; before this fix the C# side handed the saved key back to that page so it could fill in the Settings box. Now it only says *whether* a key is saved and its last 4 characters (e.g. "Key saved (…a1b2)"). Every Claude call is made from C# (`Services/ClaudeClient.cs`), as before.
- Settings: the key box stays blank with "Key saved (…a1b2). Paste a new one to replace it." Leaving it blank keeps your key. New **Remove saved key** button in Settings › AI assistant.
- Removed the old "browser mode" path that called the Claude API straight from browser JavaScript (`anthropic-dangerous-direct-browser-access`). Opened in a plain browser, the built-in assistant now says to use the Windows app or "Send to Claude" instead, and the browser never saves a key (any old one left in browser storage is ignored).
- The key is still stored encrypted with Windows DPAPI in %APPDATA%\PdfAndMoore\settings.json, never in the project folder or on GitHub. Checked: no key has ever been committed to this repo.

## v9.5.0 — Sunday, November 15, 2026
**A Print button for documents and emails, plus the email features that were missing**
- **Print button at the top of the window**, next to Save, in both Documents and Mail. In Documents it prints the open PDF; in Mail it prints the email you're reading. **Ctrl+P** does the same in both.
  - Emails print as a clean letter-size page: your account at the top, then the subject, From, To, Cc, Date (military time), the attachment names, and the message. Long emails break across pages properly.
  - If an email has pictures from the web that are still hidden, it asks first: **Include pictures** or **Without pictures** (loading them can tell the sender it was opened). Scripts and tracking links never come along.
  - There's also a **Print** button right in the email reader.
- **Save an email as a PDF**, or **Open it as a PDF in Documents** to mark it up, sign it or combine it with other files (reader › **More**).
- **Archive** (E): takes an email out of the inbox; it stays in All Mail and under its labels. **Undo** puts it back.
- **Stars**: a star on every email in the list and a **Star** button in the reader (S).
- **Mark as unread / read** (Shift+U / Shift+I). Opening an email again marks it read.
- **Labels**: **Label as…** (L) adds any Gmail label (type a new one to make it, use / for a sub-label). **Move to label…** (V) labels it and takes it out of the inbox. The email's labels show under the sender.
- **Report spam** (!) moves it to Gmail's Spam (Gmail learns from it), with Undo.
- **Spam and Trash** are in the sidebar under each account's Gmail labels. From there: **Not spam** / **Move to inbox**, or **Delete forever** (asks first; only allowed in Spam or Trash).
- **Tick several emails** with the checkboxes (or X), or tick them all with the box by the folder name. The bar that appears can Archive, Delete, Spam, mark Read / Unread, Star or Label them all at once.
- **Undo send**: after you press Send, the email waits 10 seconds with **Undo** and **Send now**. Undo brings the email back exactly as it was. Change the wait (Off, 5, 10, 20 or 30 seconds) in Settings › Email › More. A copy sits in Drafts while it waits, in case the app closes.
- **Address suggestions** in To, Cc and Bcc: start typing a name or address and pick from people you've emailed or heard from (newsletters and no-reply senders are left out). Arrow keys and Enter or Tab pick one.
- **Gmail-style keyboard shortcuts** in Mail: J / K next and previous, R reply, A reply all, F forward, C new email, E archive, # or Delete trash, ! spam, S star, Shift+U / Shift+I unread / read, L label, V move, X tick, Esc untick, / search, Ctrl+P print. Press **?** (or Ctrl+/) for the list.
- **Copy sender address** in the reader's More menu.
- New code: `wwwroot/js/print.js` (shared printing and the email print page), `MailChange.Spam` and `MailChange.DeleteForever` in `MailService.ApplyAsync` (delete forever refuses anything outside Trash or Spam). Claude's mail assistant can't use either one.

## v9.4.0 — Saturday, November 14, 2026
**One search bar that's always there, and a delete button on every email**
- **Permanent search bar** at the top of the window, in both Documents and Mail. Ctrl+F jumps to it from anywhere.
  - **Documents:** finds words in the open document as you type and highlights them; shows "3 of 12". Enter = next match, Shift+Enter = previous, or use the up/down arrows in the box.
  - **Mail:** narrows the emails on screen as you type ("Showing emails that match…" with **Show all**). Enter searches all mail on the server, every account (Gmail search words work: `from:tim`, `has:attachment`, `older_than:1y`). Esc clears it and goes back to the inbox.
  - **Both at once:** the drop-down under the box offers the other side too. From Documents: "N emails match", "Search all mail for…". From Mail: "Find … in the open document". Recent files whose names match are listed in both, so you can open them straight from the search. Arrow keys pick a row, Enter opens it.
  - The words carry over when you switch between Documents and Mail (Ctrl+1 / Ctrl+2).
- **Delete button on every email:** a trash can on each email in the list (and **Delete** in the reader, or the Delete key) moves it to Gmail's Trash. The next email opens so you can keep going. **Undo** puts it back in the inbox. Gmail keeps Trash for 30 days, so nothing is gone for good. On a draft it asks first, then removes the draft.
- The search box inside the mail list and the old floating Find bar are replaced by the new bar.
- New code: `wwwroot/js/search.js`, `mail.searchApi`, `deleteMail` / `deleteSelected` in mail.js (uses the existing `mailModify` and `mailMoveBack` bridge commands; no Windows-side changes).

## v9.3.0 — Saturday, November 14, 2026
**Drafts in every account, and Claude can clean up and organize your mail for you**
- **Drafts are saved in Gmail.** What you write is saved to the From account's own Gmail Drafts folder a few seconds after you stop typing, so it also shows in Gmail on the web and your phone. **Save draft** (or Ctrl+S) saves right away.
- **Closing keeps it.** The X (or Esc) closes the email and leaves it in Drafts, like Gmail. **Discard** throws it away and removes the draft. Sending removes the draft.
- **Drafts** in the sidebar lists drafts from every account (and each account's Drafts is under its Gmail labels). Click one to finish it: From address, To/Cc/Bcc, subject, attachments and reply threading come back as you left them, and the signature isn't added twice.
- Changing the From address to another account moves the draft to that account's Drafts.
- **Ask Claude** (top of the Mail sidebar): tell Claude in plain words how to clean up and organize your mail, for example "archive marketing older than 30 days in every account but keep real people" or "label everything from PADI and DAN as Diving". Claude searches and reads every account with Gmail search, then can add or remove labels, archive, put back in the inbox, mark read or unread, star, move to Trash, and write drafts for you to review.
- **You approve every change.** Each one shows what it will do and how many emails in each account, with a few examples. **Do it**, **Do it and the rest** (for the rest of that request; Trash always asks) or **Skip**. **Undo last change** puts labels, inbox and Trash back. Claude can't send email or delete anything for good, and reading an email doesn't mark it read.
- The assistant uses your Claude API key (Settings › AI assistant). Everything else in Mail works without it.
- New code: `MailService.SaveDraftAsync` / `DeleteDraftAsync` / `ModifyAsync` / `ModifyMatchingAsync`, special folder names (`\Drafts`, `\All`, `\Trash`) that work in any Gmail language, nested label creation, `ClaudeClient.CompleteAsync` (tool use), bridge commands `mailSaveDraft`, `mailDeleteDraft`, `mailModify`, `mailModifyMatching`, `claudeRaw`, and `wwwroot/js/mailagent.js`.

## v9.2.0 — Saturday, November 14, 2026
**Clean up the clutter, never miss a customer, see what's time-sensitive first**
- **Clutter folder:** marketing, sales pitches and loan / funding / cash-advance offers go to one **Clutter** folder (it replaces Promotions), even when they're sent to john@divemoore.com. Before, anything sent to a business address landed in that business's folder, junk included. Mass mailings are spotted by their unsubscribe headers, and Gmail labels you put on mail yourself always win. DiveVolk mail is kept.
- **Clean up (N)** button: lists the clutter in your inbox by sender with a count, all checked. Uncheck anything, or press **Keep** to mark a sender as real mail for good. **Move checked out of inbox** moves them into the Gmail label "Clutter" (same as archiving with a label). Nothing is deleted, and **Undo** puts them back.
- **Time-sensitive** smart folder and chips: Smart Sort now has Claude read every new email (not just ones your rules missed) and mark what needs action within about 2 days (red, "Time-sensitive · Sat 0800") or this week (orange). Sales deadlines never count.
- **Needs reply** is kept and now lists the most urgent first. Replying, or **Mark replied** in the reader, takes an email off both lists.
- **Customers** smart folder and a green **Customer** chip for people asking about or booking lessons, charters, hydro testing or the museum.
- **Clutter / Not clutter** buttons in the reader. Moving something out of Clutter remembers the sender.
- All mail and the unread count on the Mail button leave clutter out.
- **Updater fix:** the 9.0 → 9.1 update failed with "The update couldn't be copied into the app's folder" because the old 8.1 copy (PDF and Moore.exe.old) was never cleaned up. Start-up cleanup now keeps retrying while the previous copy closes, and an update renames a stuck .old file aside instead of failing.
- New code: `MailService.MoveToLabelAsync` / `MoveBackToInboxAsync`, bulk-mail headers on every message (`MailSummary.Bulk`), `mailMoveToLabel` / `mailMoveBack` bridge commands, settings version 3.

## v9.1.0 — Friday, November 13, 2026
**Mail sorts the way your Gmail does, and all your mail is reachable**
- **Sorting uses your Gmail labels and tabs.** Mail labeled Business, Business/Square, Millersville (and its sub-labels), Colorado Technical University, VA & Benefits, PADI/Diving, Finance, Travel or fun goes straight to the matching smart folder. Gmail's Promotions, Social and Updates tabs become smart folders too. Claude only sorts what's left, so Smart Sort is faster and cheaper.
- **New smart folders:** VA & Benefits, Diving, Finance, Travel, Promotions, Updates, Social and fun, alongside KHT, Dive Moore, Museum, Business, School and Personal. Existing settings are upgraded automatically, and any folders and rules you added are kept.
- **Rules understand Gmail:** type `label:Business` to match a Gmail label (and the labels under it), or `category:promotions` for a Gmail tab. Tab rules always run last, so a rule you add wins over "it's in Promotions".
- **Gmail labels in the sidebar:** every label with mail in it (plus Sent, Starred and All Mail) is listed under each account with its unread count. Click one to read that label, including mail your Gmail filters keep out of the inbox.
- **Load older:** the inbox now loads the newest 200 per account (was 50) and shows "Showing the newest 200 of 66,069". **Load older** brings in the next batch, and older pages stay loaded when the inbox refreshes.
- **Search all mail:** type in the search box and press Enter to search the whole mailbox on the server, not just what's loaded. Gmail search words work (`from:tim`, `has:attachment`, `older_than:1y`).
- New code: `MailService.FetchAsync` / `ListFoldersAsync` / `SearchAsync` (Gmail X-GM-LABELS and X-GM-RAW), `mailFolders` and `mailSearch` bridge commands.

## v9.0.0 — Friday, November 13, 2026
**Mail is built in, plus a new dark look with big, easy buttons**
- **Mail tab:** switch between **Documents** and **Mail** at the top left (Ctrl+1 / Ctrl+2). One inbox for every account and business address, color-coded by account, with an unread count on the Mail button. Times show in military time (1750).
- **Send as any address:** the From box lists every alias (Kona Hydrostatic Testing, Dive Moore LLC, Vintage Scuba Museum of the Pacific, personal), and the right signature is added automatically. Replies go out from the address the email was sent to.
- **Smart folders:** KHT, Dive Moore, Museum, Business, School, Personal, Newsletters, plus **All business**, **Needs reply** and **Unsorted**. Your keyword rules sort mail for free and always win. **Smart Sort** has Claude sort the rest (each email is sorted once, then remembered). "Move to…" fixes anything by hand.
- **Claude in Mail:** **Write it** (tell it what to say), one-click rewrites (Make it professional, Friendlier, Shorter, More detail, Fix spelling & grammar, Aloha touch) with **Undo Claude**, **Pick for me** (chooses the right business address), **Summarize**, and **Suggest replies** (three ready-to-edit replies). Works with whichever AI you chose in Settings.
- **Works with documents:** **Email it** on the Home ribbon (and File › Email this PDF…) sends the open PDF as an attachment. PDF and picture attachments open straight into the editor with **Open**. Drop files on the window while writing an email to attach them.
- **Safe email viewing:** HTML emails show in a locked-down frame with no scripts, and pictures stay hidden (no tracking pixels) until you click **Show pictures**.
- **New look:** **Dark theme** by default (Light is one click away), brighter colors on the ribbon and buttons, and bigger buttons and text. Settings › Look & feel has Normal, Large (default) and Extra large. PDF pages always stay white. The Word, Excel and PowerPoint windows and the update window follow the theme too.
- **One Settings window** (gear button or Ctrl+,): Look & feel, AI assistant, Email (accounts, app passwords with a step-by-step guide, aliases, signatures, smart folders, keyword rules) and Updates (check now, check at start-up).
- App passwords are stored encrypted with Windows DPAPI in %APPDATA%\PdfAndMoore\mail.json and are never shown to the web page.
- New code: `Services/MailService.cs`, `MailModels.cs`, `MailSettingsStore.cs`, `UiPrefs.cs`, `wwwroot/js/mail.js`, `settings.js`, `wwwroot/css/theme.css`, `mail.css`. New package: MailKit 4.18.1 (MIT).

## v8.1.0 — Wednesday, November 11, 2026
**Updates from inside the app**
- **Tools › Check for updates…** shows what's new in the latest version, then downloads, checks and installs it with one click. No more running Make EXE.bat for each new version.
- When a new version is out, a note appears a few seconds after the app opens. "Skip this version" and an on/off switch for the startup check are in the update window.
- The new version starts the next time PDF and Moore opens, or right away with **Restart now**. Restart closes windows the normal way, so you're still asked to save changes.
- Your current version is only replaced after the download passes its safety check (SHA-256 fingerprint). If anything fails, the old version stays. A copy installed in Program Files asks Windows for permission once to update.
- Errors are now also saved to %LOCALAPPDATA%\PdfAndMoore\crash.log so they can be fixed.
- The project now lives on GitHub (github.com/moorejohnedward/pdfandmoore). Every new version is built there automatically.
- New code: `Services/UpdateService.cs`, `UpdateWindow`, `.github/workflows/` (build check and release).

## v8 — Sunday, November 8, 2026 (night)
**Built-in Word, Excel and PowerPoint editors — no Google, everything stays on your PC**
- Replaces v7's Google editing. Word, Excel and PowerPoint files now open in PDF and Moore's own editors, each in its own window with a colored title bar (blue = document, green = spreadsheet, orange = presentation), **Save**, **Save as…**, **Print** and **Open as PDF**. Ctrl+S / Ctrl+Shift+S / Ctrl+P work. Closing with unsaved changes asks first.
- **Documents (.docx):** Word-style page editor with fonts, sizes, bold/italic/underline, colors, highlight, lists, alignment, line spacing, links, pictures, tables, undo/redo. Saves real .docx files. (.docm/.dotx open too and save as .docx.)
- **Spreadsheets (.xlsx, .xls, .csv, .ods, .xlsb, .tsv):** Excel-style grid with formulas, number formats, fonts and colors, borders, merged cells, freeze panes, filters, conditional formatting, comments, several sheets. Saves .xlsx (or .csv for CSV files). Older formats are converted and saved as a new .xlsx.
- **Presentations (.pptx):** slide editor with thumbnails (drag to reorder), new/duplicate/delete slides, text boxes, pictures (also paste), shapes, tables, fonts and colors, fill/outline colors, bring to front/back, slide backgrounds, speaker notes, zoom, and a full-screen slide show (F5). Charts come across as real PowerPoint charts. Animations, transitions and video aren't kept when saving.
- **File menu:** New document / New spreadsheet / New presentation, Open a Word, Excel or PowerPoint file, and Turn Office files into a PDF (the old convert-to-PDF behavior).
- Before an existing file is overwritten the first time, the original is copied to %LOCALAPPDATA%\PdfAndMoore\Backups.
- Old .doc/.ppt, .rtf, .odt and .odp files still open in the PDF editor (as PDF pages).
- Removed: Google sign-in, Google Drive uploads and the Google menu items.
- Editors used (all run offline inside the app): SuperDoc 1.46 (AGPL-3.0) for documents, FortuneSheet + FortuneExcel (MIT, with two export fixes) for spreadsheets, pptxtojson + PptxGenJS (MIT) for presentations.
- New code: `OfficeEditorWindow`, `wwwroot/office/` (word.html, sheet.html, slides.html, office.js, office.css, lib/).

## v7 — Sunday, November 8, 2026 (evening)
**Word, Excel and PowerPoint editing with Google, and PDF and Moore as your default app**
- **Edit Office files in Google, inside the app:** Word (.docx .doc .rtf .odt…), Excel (.xlsx .xls .csv .ods…) and PowerPoint (.pptx .ppt .odp…) files open in Google Docs, Sheets or Slides in their own PDF and Moore window. Double-click one in File Explorer, use File › Open, or File › Edit in Google Docs, Sheets or Slides.
  - Changes come back to the same file on your PC automatically (checked every 10 seconds, plus a final save when you close the window). "Save to my PC now" forces it.
  - .docx/.xlsx/.pptx (and .doc/.xls/.xlsm/.ppt) stay in their own format — Google edits the Office file itself. RTF, ODT, ODS, ODP, CSV and TSV are converted for editing and saved back in the same format. .docm, .dotx, .xlsb, .pptm and .ppsx save to a new .docx/.xlsx/.pptx beside the original.
  - Before the first overwrite, the original is copied to %LOCALAPPDATA%\PdfAndMoore\Backups.
  - Files go in a "PDF and Moore" folder in your Google Drive. The app only asks Google for access to files it uploads itself (drive.file), never your whole Drive. Reopening an unchanged file reuses the Drive copy, so Google's version history is kept.
  - "Open as PDF" sends the file to the PDF editor; "Open in my browser" is a fallback if Google sign-in won't work inside the app window.
  - Google Drive for desktop shortcuts (.gdoc, .gsheet, .gslides) open too.
  - File › Turn Office files into a PDF… keeps the old behavior (convert instead of edit). Combine files still makes one PDF.
- **One-time Google setup** (Tools › Google account…): a guided window walks through making your own free Google sign-in key ("Desktop app" client) and choosing the downloaded file. Sign-in happens in your normal web browser. Tools › Sign out of Google disconnects.
- **Default app:** Tools › Make PDF and Moore my default app… registers PDF, Word, Excel and PowerPoint types with Windows and opens Settings › Default apps › PDF and Moore so you can pick it for each type (Windows requires you to confirm this yourself). If the .exe is moved, the registration follows it.
- **Installer:** "Make Installer.bat" builds "PDF and Moore Setup.exe" (needs the free Inno Setup) — installs into Program Files with Start menu entry, desktop shortcut, uninstaller and optional file-type registration.
- All windows now share one Edge WebView2 profile, so Claude and Google sign-ins are remembered once.
- New code: `GoogleEditorWindow`, `GoogleSetupWindow`, `Services/GoogleDriveClient.cs`, `OfficeTypes.cs`, `FileAssociations.cs`, `WebViewEnv.cs`, `installer/PdfAndMoore.iss`.

## v6 — Friday, November 6, 2026 (evening)
**Fix: removing/moving groups of lines and boxes (found on the KHT Equipment Test Data Sheet)**
- "Remove the three lines and text boxes by Comments" now works with no AI at all: it finds a label's writing lines (the one beside it plus the ones stacked under it) and the fields on them, and removes, moves ("move the lines by Comments down 20") or recolors them together, as one Undo step.
- Fixed: asking to delete "the line under Comments" three times removed the same line three times. A deleted printed line now stays deleted, so the next request finds the next line.
- Fixed: when the built-in reader misunderstood a request, it showed an error and never asked Claude, even with Claude (Opus) chosen. Now, if any part fails and an AI is chosen, the change is undone and the whole request goes to the AI.
- The AI now gets a map of the page: every printed line with a number (L1, L2…), its position and the label it belongs to, plus every form field's position. It can target exact lines ("line L81") and use the new delete_near / move_near / style_near actions.
- Fixed: moving several printed lines at once could hide some of them under the white-out of the next line.
- Wordings that work: "remove the 3 lines by Comments", "delete the comments lines and boxes", "remove everything next to Comments", "remove the line by Signature", "delete line L81".

## v5 — Friday, November 6, 2026 (afternoon)
**Old documents, photos and scans**
- **More file types:** TIFF scans (every page of a multi-page scan), iPhone HEIC/HEIF photos, AVIF, ODS/ODP. Phone photos that are stored sideways now open the right way up.
- **Restore old document** (AI tab, Pages tab, Tools menu, start screen, or say "restore this document"):
  - Crops a photo to the paper and levels it (finds the page's edges on a table or background).
  - Turns pages upright (sideways or upside down) and straightens crooked ones.
  - Four looks: **Clean** (original look, white paper, darker text), **Like new** (crisp black and white), **Keep colors** (removes yellowing and stains, keeps colored ink), **Retype as new** (reads every word and rebuilds the page in clean type with its ruled lines; uncertain words highlighted).
  - Before/after preview of the current page; Undo restores the original.
- **Stronger OCR for faded, worn or low-contrast text:** each page is also read from a cleaned-up copy and a sharp black-and-white copy, and the most confident reading is kept. "Read faded" (AI tab) forces the careful mode.
- **Fill in damaged words (AI):** after reading text from an area or picture, the AI fills in worn or missing letters and words, marking guesses in [brackets].
- Skew detection evens out stains and shadows first, so stained pages straighten correctly.
- New code: `imagefix.js` (image clean-up), `restore.js` (Restore tool).

## v4 — Friday, November 6, 2026 (midday)
- **AI panel edits the document** (not just answers): text boxes, lines, logo, move/resize/recolor/delete items, edit form fields (rename, required, type, choices, delete), with Undo.
- **Make complete fillable documents from a description** (Forms › New form, start screen, command bar or AI panel): title, logo, sections, agreement text, tables, signature/date lines, real fillable fields. Works with an AI or with a field list / built-in templates (waiver, inspection checklist, sign-in sheet, invoice, registration).
- **Move lines printed in the PDF** (Edit › Move lines, key M, or "move the line under Comments down 10 points"): table borders, underlines and box edges can be dragged, nudged or deleted; crossing lines are patched so tables stay whole.
- Saved logo for "add my logo" and new forms (Insert › Change my logo).
- New icon: the app name on a form being signed, with an AI sparkle.
- Make EXE.bat copies the finished app to the school folder's "Release (app to run and share)" and points the desktop shortcut there.
- New code: `newdoc.js`, `newdocui.js`, `lines.js`.

## v3 — Friday, November 6, 2026 (morning)
- **True redaction** (mark areas or find words/SSNs/phones/emails/card numbers/dates; content is removed, not covered; hidden info stripped).
- **Lock with password** (AES-256) with print/copy/form/edit permissions; password-protected PDFs open as normal working copies.
- **Sign with a digital ID** (certificate signatures in the Windows certificate store; create, import, back up IDs).
- **Remove hidden information** (author, keywords, attachments, scripts).
- New code: `protect.js`, `Services/DigitalIdService.cs`.

## v2 — Thursday, November 5, 2026 (evening)
- Colorful ribbon (Home, Edit, Mark up, Forms, Pages, AI), plain-English command bar, free on-device AI, choice of AI (on-device, Claude account, Claude API key).

## v1 — Thursday, November 5, 2026
- WPF + WebView2 desktop app: view, edit, annotate, fillable forms (detect/name fields, signatures), OCR for crooked and upside-down scans, organize pages, convert files, Claude assistant, single-file .exe.
