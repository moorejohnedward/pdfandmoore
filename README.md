# PDF and Moore

A Windows PDF editor with Google Docs–style controls and Claude built in.
It's a C# / WPF project for Visual Studio 2022.

## Updates (v8.1 and later)

PDF and Moore updates itself: **Tools › Check for updates…** downloads, checks and installs
the newest version from this repository's Releases page. Every new version is built automatically
by GitHub Actions when the version number in `PdfAndMoore/PdfAndMoore.csproj` goes up, so you only
need `Make EXE.bat` for your very first copy (or to build changes on your own PC).

## Get the app (.exe)

1. **Install Visual Studio 2022** (Community is free). In the installer, tick the
   **".NET desktop development"** workload. (This also installs the .NET 8 SDK the build needs.)
2. **Unzip** this folder onto your PC, for example `Documents\School\PdfAndMoore`.
   Don't build it inside a Google Drive or OneDrive synced folder.
3. Double-click **`Make EXE.bat`**. A few minutes later you get **`Release\PDF and Moore.exe`**,
   one self-contained file with the PDF and Moore icon, plus a shortcut on your desktop.
   You can copy that .exe to any Windows 10/11 PC; there's nothing else to install.
4. To make it your default app for PDF, Word, Excel and PowerPoint files: open it and choose
   **Tools › Make PDF and Moore my default app…**. Windows opens Settings › Default apps › PDF and Moore;
   click each file type (.pdf, .docx, .xlsx, .pptx…) and pick PDF and Moore. (Windows only lets you do this step yourself.)

### Install it like a regular program (optional)

Install the free **Inno Setup** (`winget install --id JRSoftware.InnoSetup -e`), run **`Make EXE.bat`**, then
**`Make Installer.bat`**. You get **`PDF and Moore Setup.exe`** in the school folder's "Release (app to run and share)".
It installs into Program Files with a Start menu entry, desktop shortcut and uninstaller, and can register the file types.

### Working on the code in Visual Studio (for class)

Double-click **`PdfAndMoore.sln`** and press **F5** to run it with the debugger.
The first build downloads two small NuGet packages automatically (WebView2 and ProtectedData).

## Edit Word, Excel and PowerPoint files

Word, Excel and PowerPoint files open in PDF and Moore's own editors, each in its own window, and save back
to the same file. Everything runs on your PC; nothing is uploaded.

- **Documents** (.docx): page editor with fonts, lists, tables, pictures, links. Saves .docx.
- **Spreadsheets** (.xlsx, .xls, .csv, .ods): grid with formulas, formatting, several sheets. Saves .xlsx (CSV stays CSV).
- **Presentations** (.pptx): slides with text, pictures, shapes, tables, charts, notes and a slide show (F5). Saves .pptx.
  Animations, transitions and video aren't kept when you save.
- New blank files: **File › New document / New spreadsheet / New presentation**.
- To turn an Office file into a PDF instead: **File › Turn Office files into a PDF…**, or **Open as PDF** in the editor window.
- The first time you save over an existing file, the original is backed up to `%LOCALAPPDATA%\PdfAndMoore\Backups`.

## Tell it what to change (plain English)

Type into the rainbow bar under the ribbon and press Enter. For example:

- `Add today's date next to Technician`
- `Check 1st stage - Inspected`, `Fill Owner with John Moore`
- `Add a checkbox next to every "Yes"`, `Make the form fillable`
- `Highlight Leak test in yellow`, `Circle "Total" in red`
- `Replace "2021" with "2026"`, `White out 987-1750`
- `Add "APPROVED" at the top right in green`, `Add page numbers`, `Add a DRAFT watermark`
- `Delete page 2 and rotate page 1 right`, `Sign next to Signature`

Everyday requests like these are handled instantly by the **built-in command reader**: free, offline, no AI needed.
Anything else goes to the AI you choose. Every change is one **Undo**, and the new items are normal ones you can drag,
resize, recolor or delete (click one to get the color/size bar).

## Choose your AI assistant (AI tab › Choose AI)

| Option | Cost | Notes |
|---|---|---|
| **On this computer** | **Free for everyone** | Runs on the PC's graphics chip. It downloads once (about 1 GB for "Fast", 2 GB for "Smarter"), then works offline and documents never leave the PC. Good for simple edits and questions. Needs a reasonably recent graphics driver (WebGPU). |
| **My Claude account** | Uses your Free/Pro/Max plan | claude.ai opens next to the document; the app copies the request, you press Ctrl+V and Enter, then paste Claude's answer back. |
| **Claude API key** | Pay per use | Smartest and fully automatic. Key from <https://console.anthropic.com> › API Keys. |

> Why can't a Max plan power the app directly? Since February 2026, Anthropic doesn't allow other apps to use
> Claude Pro/Max subscription logins to run their AI features. The claude.ai window keeps your plan
> working within the rules, and the app never sees your password.

## Share it with friends

After **Make EXE.bat**, send them **`Release\PDF and Moore.exe`**, for example as a Google Drive link (it's too big for most email).
That single file is the whole app. On their PC:

- Windows may show **"Windows protected your PC"** because the app isn't from the Microsoft Store: click **More info › Run anyway**.
- They pick their own AI in **AI › Choose AI**. "On this computer" is free for them too. Nothing of yours (API key, signature, settings) is inside the .exe.

> Windows 10 and 11 already include the Microsoft Edge WebView2 Runtime the app needs.
> If you ever see a message about it, install it from
> <https://developer.microsoft.com/microsoft-edge/webview2/>.

## What it does

| Area | Features |
|---|---|
| **View** | Smooth scrolling, zoom (Ctrl + mouse wheel), fit width/page, page thumbnails, find (Ctrl+F), print |
| **Edit & mark up** | Add text, **edit existing text**, highlight/underline/strike out selected text, draw, rectangles, ellipses, lines, arrows, whiteout, sticky-note comments, images, undo/redo |
| **Fillable forms** | Fill in any PDF form; **Edit fields** to add, move, resize, rename, retype or delete fields; text, checkbox, radio, dropdown, date and **signature** fields; **Detect fields** finds blanks, table cells and check boxes automatically; **Auto-name** names fields from their labels (e.g. `IP Lockup - Pass`); Ctrl+D copies a field just below it |
| **Sign** | **Quick sign:** draw, type or upload a signature, remember it, place it anywhere or click a signature field. **Sign with ID:** a real certificate (digital ID) signature like Acrobat's — shows who signed and proves nothing changed afterwards. Create your own ID in the app, or import a .pfx/.p12 from a certificate company; IDs on smart cards also work. |
| **Protect** | **Redact** for real: mark areas, or find words, SSNs, phone numbers, emails, card numbers and dates; applying removes the text and pictures underneath for good (the rest of the page stays searchable). **Lock with password** (AES-256) and choose whether people may print, copy, fill in forms or edit. **Remove hidden info** (author, keywords, attachments, scripts). |
| **OCR** | Reads text from scans and photos, **even sideways, upside down or crooked**, and **old, faded or worn** pages (it also reads cleaned-up and black-and-white copies and keeps the best). "Grab text" reads a selected area; **Fill in damaged words (AI)** completes worn or missing letters, marking guesses in [brackets]. Searchable text layer added to the PDF. |
| **Restore old documents** | AI › Restore: crop photos to the paper, turn upright, straighten, remove yellowing/stains/shadows, darken faded text. Looks: Clean, Like new (black & white), Keep colors, or **Retype as new** (rebuilds the page in clean type). Before/after preview. |
| **Organize** | Reorder by dragging, rotate, delete, duplicate, insert blank pages or other files, extract pages, split into several PDFs |
| **Convert** | Opens PDF, Word (.docx), Excel (.xlsx/.xls/.csv/.ods), PowerPoint (.pptx, text only), pictures (PNG, JPG, TIFF multi-page scans, iPhone HEIC, WebP, AVIF…), text, HTML, RTF and ODT, and can combine many files into one PDF. Saves copies as Word, Excel, PNG/JPG, text or HTML, or as a smaller PDF. |
| **Make a form from a description** | Forms › New form (or just type "make a gear rental form with name, phone, deposit and signature"). You get a finished, good-looking PDF with real fillable fields, a header with your logo, sections, agreement text, tables and signature lines. With an AI it writes the wording too; without one, list the fields or name a kind of form (waiver, inspection checklist, sign-in sheet, invoice, registration). |
| **Move lines** | Edit › Move lines (or press M): every line printed in the PDF — table borders, underlines, boxes — lights up blue; grab one and drag it. Lines keep their direction so tables stay straight (hold Shift to move freely); arrow keys nudge; Delete removes it. Or say "move the line under Comments down 10 points", "remove the three lines and text boxes by Comments", or "make the lines by Comments blue" — a label's writing lines and their fields are handled together. |
| **Assistant edits** | In the AI panel or the command bar: add text boxes, lines and your logo; move, resize, recolor or delete things ("move the logo up 1 inch"); edit form fields ("rename Owner to Customer name", "make Technician required", "give Size the options S, M, L"). Each change has Undo. |
| **AI** | Type what to change in plain English. Free on-device AI, your Claude account, or a Claude API key. Side panel (Ctrl+J): summarize, list dates and amounts, explain or rewrite selected text, look at a page image, translate, draft an email, **fill a form from your notes**, and read handwriting Claude-style. Replies can be dropped onto the page as a text box or comment. |

## How the code is organised (for class)

```
PdfAndMoore.sln
Make EXE.bat                       Builds Release\PDF and Moore.exe (one file)
PdfAndMoore/
├─ App.xaml / App.xaml.cs          Start-up; opens a file passed on the command line
├─ MainWindow.xaml / .xaml.cs      The window: hosts WebView2, asks about unsaved changes
├─ ClaudeWebWindow.xaml / .xaml.cs  claude.ai window for signing in with a Claude account
├─ Services/
│  ├─ HostBridge.cs                Message router between the editor UI and Windows
│  ├─ ClaudeClient.cs              Calls the Claude Messages API and streams the reply
│  ├─ SettingsStore.cs             Settings + API key encrypted with Windows DPAPI
│  ├─ RecentFiles.cs               Recent files list
│  ├─ ClipboardHelper.cs           Copies text/pictures for "Send to Claude"
│  ├─ HtmlToPdfService.cs          Word/Excel → HTML → PDF using Edge's Print to PDF
│  └─ DigitalIdService.cs          Digital IDs in the Windows certificate store; CMS signatures
├─ Assets/app.ico                  App icon (a PDF in a dive mask and snorkel)
└─ wwwroot/                        The editor UI (HTML/CSS/JavaScript)
   ├─ index.html, css/app.css      Google Docs–style layout
   └─ js/
      ├─ app.js        Menus, toolbar, shortcuts, open/save
      ├─ host.js       Talks to C# (HostBridge) through WebView2 messages
      ├─ doc.js        Document model and saving (pdf-lib)
      ├─ viewer.js     Page rendering (PDF.js) and all drawing/editing tools
      ├─ forms.js      Form builder: detect, name, edit fields; signatures
      ├─ ocr.js        Orientation + skew correction and Tesseract OCR
      ├─ organize.js   Thumbnails and page operations
      ├─ convert.js    File conversions
      ├─ claude.js     AI chat panel and "Choose AI"
      ├─ commands.js   Plain-English edit commands (built-in reader + AI actions)
      ├─ protect.js    Redaction, password lock, hidden-info cleanup, digital ID signing
      ├─ imagefix.js   Image clean-up: paper flattening, contrast, adaptive black-and-white, crop/level photos
      ├─ restore.js    Restore old documents (clean, like new, keep colors, retype)
      ├─ lines.js      Finds lines printed in a PDF and makes them movable
      ├─ newdoc.js     Lays out complete fillable forms from a plan (title, sections, fields, tables)
      └─ newdocui.js   Opens new forms; your saved logo
      └─ localai.js    Free on-device AI (WebLLM)
```

**How C# and the UI talk:** the UI calls `host.js`, which sends a JSON message
`{ id, cmd, args }` through `window.chrome.webview.postMessage`.
`HostBridge.HandleAsync` runs the command (for example `openFiles`, `saveFile` or `claude`)
and posts back `{ type: "reply", id, ok, result }`. Claude replies stream back as
`{ type: "stream", id, text }` messages while they are being written.

**Libraries** (included in `wwwroot/lib`, all free/open source): PDF.js (Mozilla), pdf-lib (and the @cantoo/pdf-lib fork for password locking),
Tesseract.js (OCR), UTIF + pako (TIFF), heic2any (iPhone photos), Mammoth (Word), SheetJS (Excel), docx, JSZip, WebLLM (on-device AI), Material Symbols icons.

See **CHANGELOG.md** for what changed in each version.

## Keyboard shortcuts

Ctrl+O open · Ctrl+S save · Ctrl+Shift+S save as · Ctrl+P print · Ctrl+Z / Ctrl+Y undo/redo ·
Ctrl+F find · Ctrl+J AI panel · / type a command · V select · T text · E edit text · H highlight · U underline ·
D draw · R rectangle · A arrow · L line · W whiteout · C comment · G grab text · Ctrl+D duplicate ·
Delete remove · arrow keys nudge · Esc back to Select · hold Space to pan

## Good to know

- **Editing existing text** covers the old words with white and types new ones in Arial, Times New Roman or Courier
  (PDFs don't store text like a word processor does). This is the same idea Acrobat uses for most scans.
- When you **reorder or combine pages from different files**, fillable fields from those files are made part of
  the page (flattened). Editing a single PDF keeps its fields fillable.
- **Password-protected PDFs** open after you type the password and keep working normally (forms, text). They stay locked
  with the same password when you save; change or remove it under Protect › Password.
- **Whiteout only covers** things; the text underneath can still be copied. Use **Protect › Redact** for private information.
- **Digital IDs** you create yourself show as "issuer not trusted" in other people's Acrobat until they choose to trust it,
  just like Acrobat's own self-made IDs. For forms that need an officially trusted ID, buy one from a certificate
  company and import it. Back up your ID (Sign with ID › Back up ID) so you can use it on another computer.
- Old **.doc / .ppt** files: save them as .docx / .pptx in Office first.
- OCR reads **English**. Claude can read handwriting and other languages ("Read with Claude").
- With an API key, **Sonnet 5.5** is the default model; change it in Settings.
