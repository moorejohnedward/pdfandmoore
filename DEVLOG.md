# PDF and Moore: Development Log

**Developer:** John Moore
**Project:** PDF and Moore, a Windows PDF editor with Google Docs-style controls, built-in Word, Excel and PowerPoint editors, and Claude as an AI assistant (C#, WPF, .NET 8, Edge WebView2, JavaScript)
**Goal:** One free app for the documents I handle for school and the VA: read, mark up, fill in, sign, combine and convert PDFs, and edit Office files, without paying for Acrobat or Office.

Each entry records what was built, why, and the concepts behind it. CHANGELOG.md has the full feature list for every version, and the Git commit history on GitHub is the detailed, timestamped record of every change.

---

## Up to v8 (November 2026): The app itself

**Built (summary; see CHANGELOG.md for each version)**
- A PDF editor whose interface is a web page (HTML, CSS, JavaScript) running inside the Windows app through Microsoft Edge WebView2: page view, markup, forms, redaction, passwords, digital signatures, OCR, combining files.
- A message bridge (`HostBridge.cs` and `host.js`) so the web page can ask Windows for things it can't do itself: file dialogs, saving, printing, settings, the Claude API.
- Claude as an assistant, through the API (key encrypted with Windows DPAPI), claude.ai in a window, or a free on-device model.
- v8: built-in Word, Excel and PowerPoint editors that run offline, replacing the Google-based editing from v7.
- PDF and Moore as the default app for PDF and Office files, plus an Inno Setup installer.

**Concepts:** hybrid desktop apps (native shell + web UI), JSON messaging between C# and JavaScript, async/await, file associations in the Windows registry, data protection APIs, open-source licensing (MIT, AGPL).

---

## 2026-11-11: v8.1, In-app updates + GitHub

**Problem:** Every new version meant running Make EXE.bat on my PC, and the app had no way to tell me a newer version existed.

**Built**
- **In-app updater** (`Services/UpdateService.cs`, `UpdateWindow.xaml`): checks the GitHub Releases API for a newer version, shows the release notes, downloads the new .exe with a progress bar, checks its SHA-256 fingerprint, and swaps it in.
- **Safe self-replacement:** Windows won't let a running .exe be overwritten, but it allows renaming one. The updater renames the running file to `.old` and moves the new one into place (putting the original back if that fails). The `.old` file is deleted on the next start.
- **No lost work:** unlike Moore PC Mechanic, PDF and Moore can have unsaved documents open, so it doesn't restart on its own. The new version starts next time, or with "Restart now", which closes each window the normal way so the usual "save your changes?" questions still appear, then starts the new version as the app exits.
- **Installed copies:** if the app is in Program Files, the swap runs through PowerShell with administrator rights (one Windows permission prompt).
- **Startup check:** a few seconds after the editor loads, the app checks once in the background and the web page shows a note if an update is ready (a new `updateAvailable` bridge event and a `checkUpdates` command behind Tools › Check for updates…).
- **Crash log:** errors are written to `%LOCALAPPDATA%\PdfAndMoore\crash.log` with the version and stack trace.
- **GitHub repository + automated builds (CI/CD):**
  - `build.yml` compiles the app on GitHub's Windows servers on every push.
  - `release.yml`: when `<Version>` in the project file goes up, GitHub builds the single-file .exe with the same settings as Make EXE.bat, attaches its fingerprint and publishes a Release with notes from CHANGELOG.md.

**Concepts:** version control with Git, semantic versioning, continuous integration and delivery (GitHub Actions), REST APIs and JSON, streaming downloads with progress, cryptographic hashing, Windows UAC elevation, application lifetime events in WPF.

**Result:** after this one build, new versions arrive from inside the app.

---

## 2026-11-13: v9.0, Mail tab + Dark theme

**Problem:** The Gmail connector in Claude only works with one account at a time, and I send from three business addresses plus a personal one. I wanted one place to read and send from all of them with Claude helping, and I wanted PDF and Moore easier to read (bigger buttons, dark mode).

**Built**
- **Mail inside PDF and Moore** instead of a separate app, so documents and email share one window, one look, one settings screen and one updater. "Email it" sends the open PDF; PDF attachments open in the editor.
- **IMAP/SMTP with MailKit** (`Services/MailService.cs`): reads the inbox, downloads a message when it's opened, marks it read, sends with attachments and proper reply threading (In-Reply-To / References headers).
- **App passwords instead of OAuth:** no Google Cloud project to set up and no weekly sign-in expiry for an unverified app. Passwords are encrypted with DPAPI and never cross the bridge to JavaScript; the page only sees `hasPassword`.
- **Sorting pipeline:** deterministic rules first (which alias it was sent to, then keyword rules), AI classification second, cached in localStorage so each message is classified once. Cheap, fast and predictable.
- **AI features reuse the app's AI layer** (`askOnce` in claude.js), so Mail works with the API key, the free on-device model, or the Claude-account copy/paste mode.
- **Security:** HTML email is rendered in a sandboxed iframe (no scripts) with a Content-Security-Policy that blocks remote images until the user allows them.
- **Theming with CSS custom properties:** a `data-theme` attribute swaps the color variables; a `data-size` attribute scales controls. Set before first paint from localStorage, saved by the host in `ui.json` so WPF windows match.
- Fixed `el()` so CSS variables passed in `style` actually apply (they need `style.setProperty`), which also fixed the ribbon tab colors. Nested dialogs now only answer keys when they're on top.
- **Testing without Windows:** the web UI was exercised in headless Chrome with a fake WebView2 host, and the C# compiled on GitHub Actions on a `mail` branch before release.

**Concepts:** email protocols (IMAP, SMTP, MIME, message threading), secure secret storage, sandboxing untrusted HTML, Content Security Policy, CSS custom properties and theming, rules-then-AI classification with caching, feature branches and CI.

## 2026-11-13 (evening): v9.1, Mail sorts like Gmail

**Problem:** After setting up real accounts, the personal inbox turned out to hold 66,000+ messages, only the newest 50 were loading, and mail that Gmail filters had already labeled (VA, Millersville, Business/Square) wasn't being used for sorting.

**Built**
- **Gmail IMAP extensions:** `X-GM-LABELS` returns each message's labels in the same fetch, and `X-GM-RAW` lets the app run a Gmail search (`category:promotions`) limited to the UIDs on screen, so each message also gets its inbox tab without downloading anything extra.
- **Rule pipeline, in order:** which business alias it was sent to, then keyword and `label:` rules, then `category:` (tab) rules, then Claude for whatever is left. Deterministic rules handle almost everything now, which cuts AI calls.
- **Paging:** IMAP sequence numbers let the app fetch "the next 200 older than what's loaded"; results are de-duplicated by account + folder + UID (UIDs are only unique within one folder).
- **Folder list with counts:** one `LIST ... RETURN (STATUS (MESSAGES UNSEEN))` call gets every label and its counts.
- **Settings migration:** a version number in mail.json lets the app upgrade older settings without losing anything the user customized.

**Concepts:** IMAP UIDs vs. sequence numbers, server-side search, pagination, provider-specific protocol extensions, schema versioning and data migration.

## 2026-11-14: v9.3, Drafts and a Claude mail assistant

**Problem:** I wanted to write a long letter from my Dive Moore address and come back to it, but Mail could only send, not save drafts. And with 66,000+ emails across my accounts, I wanted to tell Claude how to clean up and organize them instead of doing it by hand.

**Built**
- **Drafts with IMAP APPEND:** a draft is a normal email message saved into the account's Drafts folder with the `\Draft` flag, so Gmail treats it as a real draft. Each save appends a new copy and removes the old one (`STORE +FLAGS \Deleted` then `UID EXPUNGE`), because IMAP messages can't be edited in place.
- **Autosave with a debounce:** the compose window saves 4 seconds after the last change, and saves are chained one after another (a promise queue) so two saves never race. A snapshot of the fields decides whether anything changed.
- **Special-use folders:** Gmail's folders have different names in different languages ("[Gmail]/Drafts", "[Google Mail]/Drafts"). The app asks the server which folder has the `\Drafts`, `\All` or `\Trash` role instead of guessing names.
- **An AI agent with tool use:** the Claude API can answer with tool calls (`search_mail`, `change_matching`…) described by JSON Schema. The app runs each tool, sends the result back, and loops until Claude gives a final answer (at most 30 rounds).
- **Human in the loop:** every change pauses the loop and shows an approval card with the exact counts per account. Changes use Gmail labels (`X-GM-LABELS`) in All Mail, where message IDs don't change, so each one can be undone by applying the opposite labels. Trash is undone by moving the messages back out of Trash.
- **Short IDs:** search results are given to Claude as m1, m2… instead of account|folder|UID strings, which saves tokens and keeps Claude from inventing IDs.
- **Testing:** the web UI was tested in headless Chrome against a fake WebView2 host with a scripted Claude, covering autosave, reopening a draft, sending, Discard, approval, and Undo. The C# compiled on GitHub Actions.

**Concepts:** IMAP APPEND/EXPUNGE and special-use mailboxes (RFC 6154), debouncing and promise queues, LLM tool use and agent loops, human-in-the-loop approval, designing reversible operations, test doubles.

## 2026-11-14 (afternoon): v9.4, one search bar and a delete button

**Problem:** Search lived in two different places (a pop-up Find bar for documents, a box inside the mail list), so I had to remember which one to use. And deleting an email meant going to Gmail.

**Built**
- **One search box in the top bar** that changes what it does with the tab you're on. A small module (`search.js`) owns the box and talks to the document and mail code through a handful of functions passed in by `app.js` (find, step, filter, searchAll…), so the box doesn't need to know how either side works inside.
- **Search as you type with a debounce:** the search waits 220 ms after the last key. A run counter throws away results from older words, so a slow search for "hy" can't overwrite the results for "hydro".
- **A drop-down of suggestions** (like a browser's address bar) that mixes results from both sides and recent files, with keyboard navigation.
- **Delete with Undo:** the email is taken off the screen right away (an "optimistic update") and moved to Gmail's Trash in the background. If the server says no, it's put back. Undo moves it out of Trash using the new ID the server returned.
- **Accessibility:** each email row became a focusable element with role="button" (a real button can't hold another button inside it), and keeps working with Enter, Space and Delete.
- **Testing:** headless Chrome with a fake WebView2 host: find/next/previous, switching tabs, filtering, server search, delete, Undo, the Delete key, and the top bar at 1280, 1500 and 1920 wide.

**Concepts:** separation of concerns and dependency injection, debouncing and stale-result races, optimistic UI updates with rollback, accessible custom controls, responsive flex layout.

