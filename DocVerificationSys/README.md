# DocVerify

DocVerify is a locally hosted document submission, extraction, deterministic verification, and human approval system. Documents remain in private disk storage; MySQL stores submissions, versions, extracted values, verification results, workflow decisions, and audit events.

It supports invoices and receipts, education records, certificates, application and declaration forms, identity/address documents, purchase orders, business documents, and a general official-document type. Extraction is best-effort label-based parsing of OCR/PDF text; it does not prove authenticity. Automated checks never approve or reject a submission.

## Requirements

- Node.js 20 or later and npm.
- MySQL 8.0.4 or later.
- Python 3.10 or later.
- Tesseract OCR for scanned PDFs and image documents.

Digitally generated PDFs with an embedded text layer can be extracted without Tesseract. The OCR service and Python packages are required for images and scanned pages.

## Windows setup (PowerShell)

1. Install MySQL and create a local application account. Use your own password:

   ```sql
   CREATE DATABASE docverify CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'docverify_user'@'localhost' IDENTIFIED BY 'REPLACE_WITH_A_LONG_PASSWORD';
   GRANT ALL PRIVILEGES ON docverify.* TO 'docverify_user'@'localhost';
   FLUSH PRIVILEGES;
   ```

2. Create the environment file and set a unique session secret:

   ```powershell
   Copy-Item .env.example .env
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Put the generated value in `.env` as `SESSION_SECRET`; set `DB_USER` and `DB_PASSWORD` to the MySQL account above. Set `ADMIN_EMAIL` to the initial administrator's address. Generate a separate random value for `OCR_SERVICE_API_KEY` and use that same value in the Node and Python service environments.

3. Install Node dependencies, apply the schema, and seed the document-type registry:

   ```powershell
   npm ci
   npm run db:migrate
   ```

4. Install Tesseract for Windows. If it is not on `PATH`, set `TESSERACT_CMD` in `.env` to the full path of `tesseract.exe`. Install the Python OCR dependencies in a virtual environment:

   ```powershell
   python -m venv .\python-ocr-service\.venv
   .\python-ocr-service\.venv\Scripts\Activate.ps1
   python -m pip install -r .\python-ocr-service\requirements.txt
   ```

5. Start the OCR service in its own PowerShell window. Set the same shared key as `OCR_SERVICE_API_KEY` in `.env`:

   ```powershell
   $env:OCR_SERVICE_API_KEY = node -e "require('dotenv').config(); process.stdout.write(process.env.OCR_SERVICE_API_KEY || '')"
   if (-not $env:OCR_SERVICE_API_KEY) { throw "OCR_SERVICE_API_KEY is missing from .env" }
   $env:TESSERACT_CMD = node -e "require('dotenv').config(); process.stdout.write(process.env.TESSERACT_CMD || '')"
   .\python-ocr-service\.venv\Scripts\python.exe -m uvicorn app:app --app-dir .\python-ocr-service --host 127.0.0.1 --port 8000
   ```

   The Node app reads the key from `.env`; the Python OCR service reads it from
   its process environment. If the key is missing or different, OCR requests
   fail with HTTP 401. Stop and restart the Python service after changing the
   key. Restart both the Node application and Python OCR service after changing
   their source code so both load the updated extraction pipeline. Jobs that
   already exhausted their retries will not restart by
   themselves; after fixing the service, upload a new version of the document.

6. Start the web application in another window:

   ```powershell
   npm start
   ```

   On first startup, DocVerify creates an administrator with a cryptographically random temporary password and prints it once in the server log. Sign in using `ADMIN_EMAIL`, then change that password immediately. The initial account is forced to change its password on first login. Protect and remove access to the log after saving the credential securely.

7. Open `http://localhost:3000`. An administrator can create submitter, reviewer, and approver accounts in **Admin → Users**.

### Development-only test users

After migrations, `npm run db:seed` creates four clearly marked `*.dev` accounts with password `DevPass123!`. This script refuses to run when `NODE_ENV=production`; do not use these accounts in a deployment.

## Workflow

1. A submitter creates a submission and selects its document type.
2. Uploading a PDF/JPEG/PNG creates an immutable document version, SHA-256 hash, and durable OCR job. After a successful upload, the submission detail page previews the current PDF or image and provides a secure link to open it.
3. The worker sends the file to the private Python service. It reads PDF text first and OCRs scanned pages/images with Tesseract.
4. Extracted values and source snippets are saved with confidence and page metadata. Review and approval pages show an OCR summary, recognized field values, extraction method/confidence, and the full unverified OCR text. Deterministic, type-specific rules run and their results are stored.
5. An assigned reviewer (or any reviewer while unassigned) opens the private uploaded file, starts the review, checks the OCR values and deterministic results, and records field corrections with reasons. The reviewer can request clarification from the submitter, or add a review summary and mark the submission reviewed to send it to the approver. The review summary is visible to the submitter and approver.
6. The assigned approver (or any approver while unassigned) reviews the file, corrected values, reviewer messages, and verification results. They may approve, reject with a reason, or return it to the submitter with a resubmission request.
7. The submitter uploads a revised version after a resubmission request. The new version is processed and returns to the reviewer queue; previous versions and audit events remain available.

Reviewer and approver pages automatically request an AI-generated summary after OCR processing is complete. Summaries and document Q&A use the current uploaded version's extracted OCR text, fields, verification results, and review messages; AI-drafted correction messages use the recorded checks and fields. These features are intended to help the human reviewer, not replace inspection of the original document. The default provider is Gemini (`AI_PROVIDER=gemini`) using `GEMINI_API_KEY`; its default model is `gemini-2.5-flash`, with `gemini-3.5-flash` as the server-error retry model. When Gemini credentials are missing/invalid or Gemini reports rate limiting/quota exhaustion, enabled Ollama fallback uses the local `qwen2.5:3b` model (`OLLAMA_MODEL`) at `http://localhost:11434`. Set `OLLAMA_FALLBACK_ENABLED=false` to disable fallback. For local-only operation, set `AI_PROVIDER=ollama`; no Gemini API key is needed. `AI_TIMEOUT_MS` bounds provider requests. With Ollama, document content stays on the local machine; with Gemini, relevant submission content is sent to Google. Do not use Gemini for documents that must not be shared with that provider. AI output can be wrong and never makes approval decisions; the reviewer and authorized approver remain responsible for their decisions.

The verification engine reports missing/invalid fields, mark/percentage consistency, invoice totals with the computed equation, invoice dates later than today, OCR confidence below 40%, and that authenticity requires human review. OCR confidence is stored as a percentage (0–100); confidence values below 40 are routed for human review. Duplicate-invoice checks compare supplier and invoice number against other `APPROVED` and `IN_REVIEW` submissions and include the conflicting request ID. No university, government, identity, supplier, or financial reference source is configured by default; the UI must not be interpreted as an authenticity certificate.

The administrator dashboard also reports average turnaround from submission creation to the latest approval/rejection decision, the share of processed submissions with at least one corrected field, and the five most frequently failing extracted fields. These are operational indicators, not measures of document authenticity.

## Document types

The registry is in `src/document-types/registry.js`. Each type defines its ID, label, category, schema version, expected fields, field aliases, and required fields. Add a type there and its fields are automatically exposed to the OCR parser, stored in `document_types` during `npm run db:migrate`, and evaluated by the shared validator. An administrator can enable/disable built-in types and configure required fields under **Admin → Document Types**. Add specialized deterministic checks to `validateFields` when justified.

Administrators may add a purchase-order reference only after checking it against an authorized source under **Admin → Reference Records**. Invoice checks compare supplier and amount only to an active record in this table. An absent or incomplete reference is reported as unavailable or requiring review; no example or institutional records are created automatically. This initial installation is single-organization (`organization_id = default`); multi-organization access controls are not implemented.

## Tests

Run unit and route smoke tests with:

```powershell
npm test
```

Run the Python OCR extraction tests with:

```powershell
.\python-ocr-service\.venv\Scripts\python.exe -m unittest discover -s .\python-ocr-service -p test_ocr.py -v
```

The unit tests cover document schemas, deterministic rules, workflow transitions, file signatures/path safety, and the unauthenticated login page. Database/OCR integration requires the MySQL credentials, the Python requirements, and Tesseract described above.

## Configuration and operations

Important `.env` values:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`: MySQL connection.
- `SESSION_SECRET`: long random secret; production requires at least 32 characters.
- `STORAGE_PATH`: private upload directory outside `src/public`.
- `MAX_FILE_SIZE_MB`, `MAX_PAGES`: upload and PDF processing limits.
- `OCR_SERVICE_URL`, `OCR_SERVICE_API_KEY`, `OCR_TIMEOUT_MS`: internal OCR service.
- `TESSERACT_CMD`: optional executable path, configured in the OCR service process.
- `AI_PROVIDER`: optional; `gemini` (default) or `ollama` for local-only AI.
- `OLLAMA_FALLBACK_ENABLED`: optional; `true` (default) uses Ollama after Gemini quota/rate-limit or credential errors.
- `OLLAMA_MODEL`: optional local Ollama model; defaults to `qwen2.5:3b`.
- `AI_TIMEOUT_MS`: optional request timeout for Gemini and Ollama; defaults to 30 seconds.
- `GEMINI_API_KEY`: optional when Ollama is primary or fallback is enabled. Create and manage this key through Google AI Studio; never commit it to source control.
- `GEMINI_MODEL`: optional; defaults to `gemini-2.5-flash`.
- `GEMINI_FALLBACK_MODEL`: optional fallback model tried after a Gemini server error; defaults to `gemini-3.5-flash`.
- `COOKIE_SECURE=true`: required behind HTTPS in production; set trusted proxy configuration only when deployment requires it.

Migrations are ordered SQL files in `src/database/migrations`. The initial migration creates the base schema; later migrations extend it without destructive resets. Apply them using `npm run db:migrate`.

Uploads are limited by MIME, extension, file signature, and size, assigned random server-side filenames, stored outside the public directory, and served only through an authenticated, authorization-checked route. Do not mount the upload directory as static content. Keep `.env`, MySQL backups, logs containing the initial password, and uploaded documents private.

## Known limitations

- OCR field mapping is based on visible field labels and works best with clean, machine-readable forms; unusual layouts require manual review.
- Tesseract is a separate Windows installation, not installed by the Python package manager.
- There is no trusted external authenticity/reference provider configured.
- AI providers do not control deterministic rules or approval decisions; local Ollama must be running at `http://localhost:11434`.
- Use HTTPS, a restricted MySQL account, protected storage/backup permissions, and a managed secret store before production use.
