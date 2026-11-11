# PDF and Moore — Roadmap to a complete office suite

**Goal:** one app that replaces Adobe Acrobat *and* Microsoft Office (Word, Excel, PowerPoint), that John owns outright,
can fix and upgrade on his own schedule, and can sell later.

**Design rule:** it has to be intuitive. Plain-English labels, big clear buttons, drag and drop everywhere,
one consistent look across PDFs, documents, spreadsheets and slides, and the AI helper available in all of them.
Mixing file types together and making training materials should take minutes, not hours.

**License rule (applies to everything we add):** only permissive open-source parts — MIT, Apache-2.0, BSD, ISC.
No AGPL/GPL (would force publishing all source code), no paid or sign-up licenses (Syncfusion, DevExpress, etc.).
Everything else is our own code.

## Where things stand (v8, Nov 8 2026)
| Part | Uses | License | Status |
|---|---|---|---|
| PDF editor | PDF.js, pdf-lib, Tesseract, Mammoth, SheetJS, docx | Apache / MIT / BSD | Keep |
| Spreadsheets | FortuneSheet + FortuneExcel | MIT | Keep, extend |
| Presentations | our slide editor + pptxtojson + PptxGenJS | MIT | Keep, extend a lot |
| Documents | SuperDoc 1.x | **AGPL — must replace** | Phase 1 |

## Phase 1 — License-clean foundation  ← next
- Replace SuperDoc with **@eigenpal/docx-editor** (Apache-2.0, ProseMirror-based .docx editor). Test open/edit/save round trips.
- Audit every file in `wwwroot/lib` and `wwwroot/office/lib`; write `THIRD-PARTY-NOTICES.txt`; list them in Help › About.
- Build v9 with Make EXE.bat and test on this PC.

## Phase 2 — Combine anything + Training Builder  (the app's signature feature)
- **Binder:** drag in any mix of PDFs, Word docs, spreadsheets, slide decks, pictures and scans; reorder pages and sections
  by dragging; pick which sheets/slides to include; get one finished PDF with a cover page, table of contents,
  section dividers, page numbers, headers/footers and your logo.
- **Training Builder:** turn material into a course in a few steps:
  - templates: SOP / procedure, step-by-step with photos, safety briefing, checklist, sign-off sheet, certificate of completion
  - quizzes (multiple choice, true/false) with answer key, and a printable or fillable version
  - "Make training from this": the AI drafts objectives, steps, key points and quiz questions from any document
  - output as a printable training binder (PDF), a slide deck for teaching, and fillable forms for sign-offs
- Save a binder as a project so it can be updated and rebuilt later (e.g. when a procedure changes).

## Phase 3 — Presentations toward PowerPoint
1. Save by updating the original .pptx in place, so anything not edited (animations, transitions, layouts, video, effects) is kept.
2. Rotate handle, multi-select, group/ungroup, align & distribute, snap guides, copy/paste between slides.
3. Full shape gallery, gradients, shadows, picture crop/effects, text box autofit, line spacing, columns.
4. Tables: add/remove rows & columns, cell colors/borders. Charts: edit the data.
5. Themes, slide masters & layouts, slide size.
6. Animations & transitions: add, edit, preview, play in slide show, save.
7. Video & audio. Presenter view (notes, next slide, timer). Export to PDF / pictures.

## Phase 4 — Documents toward Word
Styles, headers/footers, page numbers, page setup, find & replace, comments, track changes, spell check, table of contents, export to PDF.

## Phase 5 — Spreadsheets toward Excel
Charts, print & PDF export, sort/filter polish, more formulas, data validation, pivot-style summaries.

## Phase 6 — Everything in one place
One home screen with recent files of every type, tabs in one window, New menu for all file types,
installer (Program Files + Start menu + uninstaller), default-app registration, auto-update.

## Phase 7 — Getting ready to sell
Final name & trademark check, code-signing certificate (so Windows doesn't warn), website & download page, pricing,
our own license terms, and a lawyer's look at the third-party notices.

## Working tips
- Start a **new Claude chat for each phase** (or each big step) and say: "Continue the PDF and Moore roadmap, Phase N."
  Long chats use a lot more of the plan's allowance.
- Each version gets its own folder (`PdfAndMoore vN`) and zip; CHANGELOG.md records what changed.
