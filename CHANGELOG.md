# PDF and Moore — change log

A record of what was built and when (Hawaii time). Newest first.

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
