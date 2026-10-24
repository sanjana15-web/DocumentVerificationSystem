# DocVerify Codebase Guide

This guide explains how the project is organized and how its main pieces work
together. It is intended as a starting point for someone new to the code.

## 1. What the application does

DocVerify is a locally hosted document submission and human-review application.
A submitter uploads a document; the system extracts text, fills in likely field
values, and runs deterministic checks. A reviewer can inspect the original
document, correct extracted values, and forward the submission to an approver.
The approver makes the final decision.

Automated extraction and checks are aids for people. They do not prove a

document is authentic and do not make approval decisions.

## 2. Technologies and application shape

- **Node.js and Express** serve the application and coordinate its workflow.
- **EJS** renders the HTML pages on the server.
- **MySQL** stores users, submissions, document versions, OCR results,
  verification results, workflow activity, and sessions.
- **Python, FastAPI, PyMuPDF, Pillow, and Tesseract** power the separate OCR
  service. PDFs with embedded text are read directly; scanned PDF pages and
  images use Tesseract.
- **Private disk storage** holds uploaded files. The file contents are not
  stored in MySQL and are not served as public static files.

At a high level, a browser request goes through Express middleware, a route,
and a controller. Controllers call services for business operations and
repositories for database access. The controller then renders an EJS template
or redirects the browser.

```text
Browser
  -> Express middleware (session, CSRF, user, security)
  -> Route (URL, authentication and role requirements)
  -> Controller (request handling and page response)
  -> Service (workflow, OCR, verification, authentication)
  -> Repository -> MySQL
                  -> private file storage
                  -> Python OCR service (for document extraction)
  -> EJS view -> Browser
```

## 3. Main document workflow

1. A submitter creates a submission with a title and document type.
2. The submitter uploads a PDF, JPEG, or PNG. The Node application checks the
   declared type, file extension, file signature, and size; it assigns a
   server-generated filename, stores a SHA-256 hash, and records a new document
   version.
3. An OCR job is added to the database-backed job queue. The worker in
   `src/services/jobProcessor.js` claims pending jobs and retries failures.
4. `src/services/ocrService.js` sends the file and that type's field schema to
   the private Python service. Extracted text, field values, confidence,
   source snippets, and page numbers are saved.
5. `src/services/verificationEngine.js` runs deterministic checks and saves
   their results. The submission moves to a reviewer queue.
6. A reviewer examines the document and OCR results, may correct fields with
   reasons, reads the optional AI-generated summary as an aid (not as a
   replacement for the source document), and can request clarification or
   forward it for approval.
7. An approver reviews the submission and approves, rejects, or requests
   resubmission. New uploads create new document versions; previous versions
   and audit events remain available.

### Statuses in plain language

- `DRAFT`: created, but not yet being processed.
- `PROCESSING`: an uploaded version is being extracted and checked.
- `REVIEW_REQUIRED` / `NEEDS_REVIEW`: ready for a reviewer; the latter
  indicates a check specifically requires human attention.
- `IN_REVIEW`: a reviewer has started their work.
- `CLARIFICATION_REQUIRED`: the submitter needs to answer a reviewer question.
- `CHANGES_REQUESTED`: the submitter needs to provide a revised document.
- `PENDING_APPROVAL`: the reviewer has forwarded it to an approver.
- `APPROVED` / `REJECTED`: an approver has made a decision.
- `PROCESSING_FAILED`: automated extraction failed and needs a retry or new
  upload.

Allowed changes between statuses are centralized in
`src/services/statusTransitions.js`; controllers use this state machine rather
than trusting a status supplied by the browser.

## 4. Important directories and files

### Application startup and configuration

- `src/app.js` creates the Express app, configures security headers, sessions,
  CSRF protection, request logging, static assets, shared template values, and
  routes. On startup it tests the database connection, provisions an initial
  administrator if needed, and starts the OCR job processor.
- `src/config/env.js` reads `.env` and provides typed application settings for
  the database, sessions, storage, OCR, optional AI, and security.
- `src/config/database.js` creates the MySQL connection pool and offers query
  and transaction helpers.
- `.env.example` documents the environment variables to configure. Keep real
  secrets in `.env`, not in source code.

### Routes, controllers, and middleware

- `src/routes/` maps URL paths and HTTP methods to controller functions.
  `auth.js` handles sign-in and password changes, `submissions.js` handles
  document and review actions, `admin.js` restricts administration to admins,
  and `misc.js` handles other pages.
- `src/controllers/` handles browser input and responses. Controllers validate
  inputs, apply access checks, call services/repositories, and render views.
  The main workflow is in `submissionController.js`; login and account
  management are in `authController.js`; administrative pages are in
  `adminController.js`.
- `src/middleware/auth.js` loads the session user and enforces sign-in and
  role checks. `src/middleware/upload.js` validates uploaded files and keeps
  file paths within private storage. `src/middleware/errorHandler.js` formats
  application errors and missing-page responses.

### Services and document types

- `src/services/authService.js` checks passwords, applies password rules, and
  provisions the first administrator.
- `src/services/jobProcessor.js` polls the database queue, claims OCR work,
  retries failed jobs, updates status, and notifies users.
- `src/services/ocrService.js` calls the Python service, checks its response,
  and persists OCR output.
- `src/services/verificationEngine.js` runs checks and stores a versioned
  verification run. Invoice checks include potential duplicates and an
  optional configured purchase-order reference comparison.
- `src/services/aiService.js` contains the optional OpenAI-based assistant.
  When enabled, reviewer and approver pages automatically request an AI
  summary after OCR is complete and also allow document Q&A. It is not part of
  deterministic verification and cannot make decisions. Relevant submission
  content is sent to OpenAI.
- `src/document-types/registry.js` defines built-in document types, their
  fields, aliases (labels to look for in OCR text), required fields, and
  shared deterministic validation logic.
- `src/services/statusTransitions.js` is the allowed workflow transition map.

### Database access and schema

- `src/repositories/` contains database operations grouped by topic:
  submissions, users, document versions and OCR fields, document types, audit
  events, notifications, verification runs, comments, and approvals.
  Repositories keep SQL persistence details out of most controllers.
- `src/database/migrations/` contains ordered SQL schema migrations.
  `src/database/migrate.js` applies them and registers built-in document types
  and verification rules.
- `src/database/seed.js` creates development-only accounts. It refuses to run
  in production.

The main records are connected roughly like this:

```text
users -> submissions -> document_versions -> OCR results and extracted_fields
                    -> verification runs and rule results
                    -> comments, corrections, decisions, notifications, audit
```

Uploaded file bytes live separately on disk; `document_versions` stores their
metadata and private storage path.

### OCR service

- `python-ocr-service/app.py` exposes the private `/extract` endpoint. It
  authenticates the Node service with a shared API key, validates file
  signatures and size, reads embedded PDF text where possible, and uses
  Tesseract for images or scanned pages. Its field parser searches lines for
  each schema alias and ignores non-numeric text for decimal fields.
- `python-ocr-service/requirements.txt` lists the Python dependencies.
- `python-ocr-service/test_ocr.py` tests that embedded PDF text is extracted
  and mapped to fields without requiring OCR for that PDF.

### User interface, tests, and supporting files

- `src/views/` contains EJS templates organized into authentication,
  submissions, approval, administration, dashboard, shared partials, and error
  pages.
- `src/public/css/main.css` contains the application's styles.
- `src/utils/viewHelpers.js` provides formatting helpers to EJS templates;
  `src/utils/logger.js` configures application logging.
- `tests/core.test.js` covers core validation and workflow behavior, file
  checks, view rendering, and login-page behavior.
- `storage/` is intended for private uploaded documents, not public web assets.
- `README.md` explains setup, configuration, and how to run the application.

## 5. How verification works

`registry.js` compares extracted values to each document type's schema and
creates rule results such as missing required values, invalid dates or numeric
values, low OCR confidence, and document-specific consistency checks. The
verification engine stores each run and each result so reviewers can see what
was checked.

For invoices, additional checks look for a matching supplier and invoice number
in eligible submissions and compare invoice values to an active configured
purchase-order reference if one exists. A missing trusted reference is not
treated as proof of authenticity. The system intentionally leaves authenticity
and final decisions to a human.

## 6. Security concepts used by the project

- Sessions are stored in MySQL in normal application use; cookies are HTTP-only
  and use same-site settings.
- CSRF protection applies to state-changing browser requests.
- Express uses security headers, and login/API/assistant endpoints have rate
  limits.
- Passwords are stored as bcrypt hashes. User roles and submission ownership
  are checked on the server.
- File uploads use generated names, type/extension/signature checks, size
  limits, a hash, private storage, and authorized download routes.
- The OCR service requires a shared API key and validates the uploaded file
  again. Its output is treated as extracted data, not trusted facts.
- Production configuration requires a strong session secret and secure
  cookies over HTTPS.

These controls reduce risk but do not make a deployment automatically
production-ready. Review `README.md` for operational requirements and known
limitations.

## 7. Running and testing

From the project root in PowerShell:

```powershell
npm start
npm test
npm run db:migrate
```

The app requires a configured MySQL database. Full OCR for scanned pages and
images also requires the Python dependencies and a Tesseract installation.
See `README.md` for the complete Windows setup and OCR service commands.

## 8. Suggested reading order

If you are learning the code, this order follows the main path through it:

1. `src/app.js` — how the server is assembled.
2. `src/routes/submissions.js` — the submission URLs and access requirements.
3. `src/controllers/submissionController.js` — how requests become workflow
   actions.
4. `src/middleware/upload.js` — how document files are accepted and stored.
5. `src/services/jobProcessor.js` — how OCR work is queued and processed.
6. `src/services/ocrService.js` and `python-ocr-service/app.py` — how text and
   fields are extracted.
7. `src/document-types/registry.js` and
   `src/services/verificationEngine.js` — how deterministic checks run.
8. `src/services/statusTransitions.js` — which workflow movements are allowed.
9. `src/repositories/` and `src/database/migrations/` — how data is persisted.
    behavior is checked.

## 9. Code changes log (2026-10-22)

### OCR failure diagnosis and extraction safeguards

- Recent OCR jobs failed after three attempts with HTTP 401 from the private
  Python OCR service. Ensure its `OCR_SERVICE_API_KEY` environment variable
  exactly matches the Node app's `.env` value; restart the Python service after
  changes. Already exhausted jobs require a new document upload.
- Decimal field extraction now ignores OCR candidates that are not numeric,
  preventing tax identifiers such as `IN: 27ABCDE...` from being stored as a
  tax amount.
- Verification results shown for a submission are now limited to its current
  document version, so a failed new upload cannot show the previous version's
  checks as if they came from the new file.

### A. Gemini model and fallback fix

**`.env`** — Added `GEMINI_FALLBACK_MODEL=gemini-3.5-flash`.

Previously `.env` had no `GEMINI_FALLBACK_MODEL`, so `config.ai.geminiFallbackModel` defaulted to
`gemini-2.5-flash-lite` (env.js line 69). That model returns HTTP 404 for this API key. The fallback
retry path in `aiService._call` was wired correctly, but the model it tried would immediately 404.

Live diagnostic (2026-10-22):
- `gemini-2.5-flash` → HTTP 200 ✅ (primary; unchanged)
- `gemini-2.5-flash-lite` → HTTP 404 ❌ (not available for this key)
- `gemini-3.5-flash` → HTTP 200 ✅ (selected as fallback)
- `gemini-3.8-flash` → HTTP 503 ⚠ (high demand — root cause of the original 502 errors)

### B. AI-drafted correction messages (new feature — from PPT slide 5)

The presentation promised: *"GenAI assistant… drafts correction messages from saved data."*
This was the one AI feature missing from the implementation.

**`src/services/aiService.js`** — Added `draftCorrectionMessage()`.
- Builds prompt from failed/warning checks, missing fields, reviewer-corrected values only.
- All submission data escaped with `escapePromptData` inside `<submission_untrusted_data>` tags.
- Explicit instruction not to approve/reject.
- Returns the draft text; caller must still send it.

**`src/controllers/submissionController.js`** — Added `draftClarificationMessage()`.
- Requires reviewer/approver/admin role.
- Requires current document version.
- Returns `{ draft }` JSON or structured error JSON.

**`src/routes/submissions.js`** — Added:
`POST /:id/assistant/draft-correction` (rate-limited at 20 req/min).

**`src/views/submissions/detail.ejs`** — Clarification modal updated:
- Added `id="clarify-message"` to textarea.
- Added "✦ Draft with AI" button (shown only when AI is enabled and a document exists).
- Client JS calls the endpoint and pre-fills the textarea. Privacy notice included.

**`src/views/approval/decision.ejs`** — "Return to submitter" form updated:
- Same "✦ Draft with AI" button for approvers.

### C. Tests added (tests/core.test.js)

Three new tests added; total is now **19/19 passing**:
1. AI draft correction: only FAIL checks in prompt; escaped HTML; no approve/reject wording.
2. Model-not-found (404): error names the model and references GEMINI_MODEL.
3. GEMINI_FALLBACK_MODEL env wiring: verified the fallback is read from config and retried on 503.

### D. Unchanged
- Approval/rejection logic unchanged; human decisions remain entirely in human hands.
- No database schema change; no migration required.
- `.env` secret values unchanged (only `GEMINI_FALLBACK_MODEL` line added).
- Python OCR service unchanged.
- All 16 original tests still pass.

---

## 10. Follow-up session (2026-10-23) — Gemini still not working diagnosis

### Root cause (confirmed)

The `npm start` process had been running for **17+ hours** without a restart.
Node loads `.env` once at startup via `require('dotenv').config()` and never re-reads it.
Therefore:
- The change from `GEMINI_MODEL=gemini-3.8-flash` to `gemini-2.5-flash` was **invisible** to the running process.
- The new `GEMINI_FALLBACK_MODEL=gemini-3.5-flash` line was also **invisible**.
- The live server was still calling `gemini-3.8-flash` which was returning HTTP 503.

The server was also **not actually listening on port 3000** when checked — the process had likely
crashed or the terminal session had ended.

### Fix applied

Restarted the server with `node src/app.js`. The new process loaded the correct `.env` and new code.

Confirmed working:
- `http://localhost:3000/health` → `status: ok | ai: configured`
- Live Gemini test → `gemini-2.5-flash` HTTP 200, response "WORKING"

### Rule: always restart the server after changing .env or application code

Any change to `.env` or to files in `src/` requires restarting the Node process before those
changes take effect in the browser. In development, stop the current `npm start` terminal and
run `npm start` again.

### Test count updated

20/20 tests now pass (the user added a test for verification result scoping to current doc version).

### IMPORTANT: after the next .env or code change

```powershell
# In the DocVerification project directory:
# Stop the running server (Ctrl+C in its terminal), then:
npm start
```

## 11. OpenAI provider change (2026-10-23)

The AI assistant now uses OpenAI instead of Gemini. Configure `OPENAI_API_KEY`
in `.env`; `OPENAI_MODEL` defaults to `gpt-4.1-mini`, and
`OPENAI_FALLBACK_MODEL` defaults to `gpt-4.1-nano`. Server errors trigger a
retry with the fallback model. This can help with model-specific availability
problems, but does not prevent provider outages, rate limits, quota errors, or
model-access errors. The configured submission content is sent to OpenAI.

## 12. Invoice extraction and verification fixes

Invoice OCR now canonicalizes common field-name aliases, extracts labeled values
from embedded PDF text and OCR output, normalizes supported dates to ISO format,
and normalizes currency amounts before persistence. Missing OCR values remain
SQL `NULL` rather than the literal string `"null"`. The invoice database schema
is updated by migrations so optional due dates and discounts remain optional,
and the stored OCR aliases stay aligned with the application schema.

## 13. Gemini provider restored (2026-10-23)

The optional AI assistant uses Google Gemini. Configure `GEMINI_API_KEY` in
`.env`; `GEMINI_MODEL` defaults to `gemini-2.5-flash`, with
`GEMINI_FALLBACK_MODEL` defaulting to `gemini-3.5-flash`. The API key is sent
in the `x-goog-api-key` header, not logged or placed in the request URL. A
server-side model error triggers a retry with the fallback model. AI summaries,
document questions, and correction drafts send relevant submission content to
Google Gemini; deterministic verification and approval workflows do not depend
on the AI provider.

## 14. Invoice header and financial summary parsing (2026-10-23)

Invoice label matching now requires a complete configured label or an explicit
descriptor boundary, preventing generic words such as "tax" and "vendor" from
matching unrelated tax-registration and narrative text. Date values discard
parenthetical payment terms; labeled monetary fields reject invalid text rather
than persisting it as an amount. The extractor recognizes issue dates, billed-to
headers, purchase-order references, and billing currency. When taxable and
non-taxable subtotal components are both explicitly labeled, the canonical
subtotal is their sum so the existing total arithmetic check can compare it
against tax and grand total. An unlabeled vendor name is inferred only from a
document header immediately followed by an address-shaped line. Migration
`006_invoice_header_and_summary_aliases.sql` updates stored invoice aliases.

The BrightByte upload `DOC-2026-60C7CB3C05` exposed additional Tesseract layout
cases: the invoice-number label appears mid-line, the GST amount follows its
rate on the same OCR line, the rupee sign may be OCR'd as `I` or omitted, and
the supplier is repeated in the closing signature. The parser now handles
these patterns, keeps tax rate in a separate field, and infers INR only from
explicit Indian-currency evidence or corroborating Indian invoice markers.
`python-ocr-service/tests/fixtures/brightbyte_uploaded_invoice.jpg` is the
actual uploaded image used by the OCR regression test. Diagnostics include
redacted OCR excerpts, candidate/normalized field values, and hashes instead
of logging the full raw document.

Migration `007_invoice_tax_rate_field.sql` persists the separate optional tax
rate field. Node logs the normalized invoice fields before persistence and the
same field values passed into verification; the existing amount rule continues
to treat an absent optional discount as zero and rejects an incorrect total.
