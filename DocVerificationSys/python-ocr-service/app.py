"""Private OCR service for DocVerify. Uploaded content is treated as untrusted data."""

from __future__ import annotations

import io
import json
import logging
import os
import re
import time
import hashlib
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import pymupdf
import pytesseract
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from PIL import Image, ImageOps
from pytesseract import Output

MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE_MB", "10")) * 1024 * 1024
MAX_PAGES = int(os.getenv("MAX_PAGES", "50"))
EXPECTED_API_KEY = os.getenv("OCR_SERVICE_API_KEY", "")
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "")
logger = logging.getLogger("docverify.ocr")
if TESSERACT_CMD:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

app = FastAPI(title="DocVerify OCR Service", docs_url=None, redoc_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service_version": "1.0"}


@app.post("/extract")
async def extract_document(
    file: UploadFile = File(...),
    mime_type: str = Form(...),
    document_version_id: str = Form(...),
    document_type: str = Form(...),
    fields_json: str = Form(...),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict[str, Any]:
    if not EXPECTED_API_KEY or x_api_key != EXPECTED_API_KEY:
        raise HTTPException(status_code=401, detail="OCR service authentication failed.")
    if mime_type not in {"application/pdf", "image/jpeg", "image/png"}:
        raise HTTPException(status_code=415, detail="Unsupported document type.")

    try:
        schema = json.loads(fields_json)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid field schema.") from exc
    if not isinstance(schema, list) or len(schema) > 100:
        raise HTTPException(status_code=400, detail="Invalid field schema.")

    content = await file.read(MAX_FILE_SIZE + 1)
    if not content or len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File is empty or exceeds the upload size limit.")
    if not has_expected_signature(content, mime_type):
        raise HTTPException(status_code=415, detail="File signature does not match its declared type.")

    started = time.monotonic()
    logger.info("OCR started: stage=ocr document_version_id=%s document_type=%s", document_version_id, document_type)
    try:
        pages, page_confidences, methods = process_document(content, mime_type)
    except HTTPException as exc:
        logger.error(
            "OCR failed: stage=ocr document_version_id=%s status=%s reason=%s",
            document_version_id,
            exc.status_code,
            exc.detail,
        )
        raise
    except Exception as exc:
        logger.error(
            "OCR failed: stage=ocr document_version_id=%s error_type=%s",
            document_version_id,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="OCR processing failed unexpectedly.") from exc
    raw_text = "\n\n".join(page["text"] for page in pages).strip()
    if not raw_text:
        logger.warning("OCR failed: stage=ocr document_version_id=%s reason=no_readable_text", document_version_id)
        raise HTTPException(status_code=422, detail="No readable text was found in this document.")

    confidence = round(sum(page_confidences) / len(page_confidences), 2) if page_confidences else 100.0
    method = methods[0] if len(set(methods)) == 1 else "hybrid"
    try:
        fields = extract_fields(schema, pages, confidence, method)
    except Exception as exc:
        logger.error(
            "Extraction failed: stage=extraction document_version_id=%s error_type=%s",
            document_version_id,
            type(exc).__name__,
        )
        raise HTTPException(status_code=500, detail="Structured field extraction failed.") from exc
    missing_required = [
        canonical_field_id(spec.get("id"))
        for spec in schema
        if spec.get("required") and fields.get(canonical_field_id(spec.get("id")), {}).get("value") is None
    ]
    invalid_formats = [
        canonical_field_id(spec.get("id"))
        for spec in schema
        if (value := fields.get(canonical_field_id(spec.get("id")), {}).get("value")) is not None
        and ((spec.get("type") == "date" and normalize_date(value) is None)
             or (spec.get("type") == "decimal" and normalize_money(value) is None))
    ]
    if missing_required or invalid_formats:
        logger.warning(
            "Invoice field extraction incomplete: stage=extraction document_version_id=%s "
            "missing_required=%s invalid_formats=%s",
            document_version_id,
            ",".join(missing_required),
            ",".join(invalid_formats),
        )
    logger.info(
        "OCR complete: stage=extraction document_version_id=%s extraction_method=%s "
        "fields_found=%s page_count=%s",
        document_version_id,
        method,
        sum(info["value"] is not None for info in fields.values()),
        len(pages),
    )
    return {
        "success": True,
        "raw_text": raw_text,
        "page_count": len(pages),
        "extraction_method": method,
        "avg_confidence": confidence,
        "processing_ms": int((time.monotonic() - started) * 1000),
        "service_version": "1.0",
        "fields": fields,
        "line_items": [],
    }


def has_expected_signature(content: bytes, mime_type: str) -> bool:
    if mime_type == "application/pdf":
        return content.startswith(b"%PDF-")
    if mime_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if mime_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    return False


def process_document(content: bytes, mime_type: str) -> tuple[list[dict[str, Any]], list[float], list[str]]:
    pages: list[dict[str, Any]] = []
    confidences: list[float] = []
    methods: list[str] = []

    if mime_type == "application/pdf":
        try:
            pdf = pymupdf.open(stream=content, filetype="pdf")
        except Exception as exc:
            raise HTTPException(status_code=422, detail="The PDF could not be opened.") from exc
        if pdf.needs_pass:
            raise HTTPException(status_code=422, detail="Password-protected PDFs are not supported.")
        if not pdf.page_count or pdf.page_count > MAX_PAGES:
            raise HTTPException(status_code=422, detail=f"PDF page count must be between 1 and {MAX_PAGES}.")
        for page_number, page in enumerate(pdf, start=1):
            text = page.get_text("text").strip()
            if len(text) >= 10:
                pages.append({"page": page_number, "text": text})
                confidences.append(100.0)
                methods.append("embedded_text")
            else:
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                image = Image.open(io.BytesIO(pixmap.tobytes("png")))
                text, confidence = run_ocr(image)
                pages.append({"page": page_number, "text": text})
                confidences.append(confidence)
                methods.append("tesseract")
        pdf.close()
        return pages, confidences, methods

    try:
        image = Image.open(io.BytesIO(content))
        image.verify()
        image = Image.open(io.BytesIO(content))
    except Exception as exc:
        raise HTTPException(status_code=422, detail="The image could not be decoded.") from exc
    text, confidence = run_ocr(image)
    return [{"page": 1, "text": text}], [confidence], ["tesseract"]


def run_ocr(image: Image.Image) -> tuple[str, float]:
    prepared = ImageOps.autocontrast(ImageOps.grayscale(image))
    try:
        data = pytesseract.image_to_data(prepared, output_type=Output.DICT)
    except pytesseract.TesseractNotFoundError as exc:
        raise HTTPException(status_code=503, detail="Tesseract is not installed or TESSERACT_CMD is invalid.") from exc
    try:
        text = pytesseract.image_to_string(prepared)
    except pytesseract.TesseractNotFoundError as exc:
        raise HTTPException(status_code=503, detail="Tesseract is not installed or TESSERACT_CMD is invalid.") from exc
    scores = []
    for word, raw_score in zip(data["text"], data["conf"]):
        if word.strip():
            try:
                score = float(raw_score)
            except (TypeError, ValueError):
                continue
            if score >= 0:
                scores.append(score)
    confidence = sum(scores) / len(scores) if scores else 0.0
    return text.strip(), confidence


def extract_fields(
    schema: list[dict[str, Any]], pages: list[dict[str, Any]], confidence: float, method: str
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    all_aliases = [
        alias
        for spec in schema
        for alias in [
            *(spec.get("aliases") if isinstance(spec.get("aliases"), list) else []),
            *field_aliases(spec.get("id")),
        ]
        if isinstance(alias, str) and alias
    ]
    for spec in schema:
        name = spec.get("id")
        if not isinstance(name, str):
            continue
        value = None
        source_text = None
        page_number = None
        aliases = spec.get("aliases") if isinstance(spec.get("aliases"), list) else []
        aliases = [*aliases, *field_aliases(name)]
        field_type = spec.get("type")
        canonical_name = canonical_field_id(name)
        if canonical_name == "tax_rate":
            for page in pages:
                for line in page["text"].splitlines():
                    rate = extract_tax_rate(line)
                    if rate:
                        value = rate
                        source_text = line.strip()
                        page_number = page["page"]
                        break
                if value:
                    break
            if value:
                result[canonical_name] = {
                    "value": value,
                    "confidence": round(min(confidence, 90.0), 2),
                    "data_type": field_type,
                    "source_text": source_text,
                    "page_number": page_number,
                    "extraction_method": method,
                }
                continue
        for page in pages:
            lines = page["text"].splitlines()
            for line_index, line in enumerate(lines):
                for alias in sorted((a for a in aliases if isinstance(a, str) and a), key=len, reverse=True):
                    label = re.escape(alias).replace(r"\ ", r"\s+")
                    pattern = rf"^\s*(?:[-*]\s*)?{label}(?:\s*[:#=-]\s*|\s*(?=[(/])|$)(.*?)\s*$"
                    match = re.search(pattern, line, flags=re.IGNORECASE)
                    if not match and canonical_name == "invoice_number":
                        match = re.search(rf"\b{label}\s*[:#=-]\s*(.+?)\s*$", line, flags=re.IGNORECASE)
                    if not match:
                        continue

                    candidate = match.group(1).strip()
                    if canonical_name == "tax_amount":
                        candidate = find_tax_amount(candidate, lines, line_index, all_aliases)
                        if candidate is None:
                            continue
                    elif not candidate:
                        candidate = find_following_value(lines, line_index, all_aliases)
                        if candidate is None:
                            continue
                    elif field_type == "decimal" and normalize_money(candidate) is None:
                        candidate = find_following_money(lines, line_index, all_aliases)
                        if candidate is None:
                            continue
                    elif field_type == "date" and normalize_date(candidate) is None:
                        if not is_label_continuation(candidate):
                            continue
                        candidate = find_following_value(lines, line_index, all_aliases)
                        if candidate is None:
                            continue
                    elif is_label_continuation(candidate):
                        candidate = find_following_value(lines, line_index, all_aliases)
                        if candidate is None:
                            continue
                    if candidate:
                        candidate = strip_following_field_label(candidate, all_aliases)
                        if canonical_name == "tax_amount":
                            normalized = normalize_money(candidate)
                            if normalized is None:
                                continue
                        else:
                            normalized = normalize_currency(candidate) if canonical_name == "currency" else normalize_field_value(candidate, field_type)
                        if field_type in {"decimal", "date"} and normalized is None:
                            continue
                        value = normalized if normalized is not None else candidate
                        source_text = line.strip() if candidate in line else f"{line.strip()} {candidate}".strip()
                        page_number = page["page"]
                        break
                if value:
                    break
            if value:
                break
        canonical_name = canonical_field_id(name)
        if canonical_name == "subtotal":
            components = extract_subtotal_components(pages)
            if components is not None:
                value = components
                source_text = "Taxable and non-taxable subtotal components"
                page_number = pages[0]["page"] if pages else None
        if canonical_name == "vendor_name" and value is None:
            for page in pages:
                vendor = infer_vendor_from_header(page["text"])
                if vendor:
                    value = vendor
                    source_text = vendor
                    page_number = page["page"]
                    break
        result[canonical_name] = {
            "value": value,
            "confidence": round(min(confidence, 90.0), 2) if value else 0,
            "data_type": spec.get("type", "string"),
            "source_text": source_text,
            "page_number": page_number,
            "extraction_method": method,
        }
    currency_field = result.get("currency")
    if currency_field and currency_field["value"] is None:
        currency, evidence, inferred = infer_currency(pages)
        if currency:
            currency_field.update({
                "value": currency,
                "confidence": round(min(confidence, 70.0 if inferred else 90.0), 2),
                "source_text": evidence,
                "page_number": next((page["page"] for page in pages if evidence in page["text"]), None),
                "extraction_method": method,
            })

    raw_candidates = {
        field_name: {
            "raw_candidate": redact_diagnostic_text(info["source_text"]),
            "normalized_value": redact_diagnostic_text(str(info["value"])) if info["value"] is not None else None,
        }
        for field_name, info in result.items()
        if info.get("value") is not None
    }
    raw_text = "\n".join(page["text"] for page in pages)
    candidate_text = "\n".join(dict.fromkeys(
        info["source_text"] for info in result.values() if info.get("source_text")
    ))
    logger.info("OCR extraction diagnostics: %s", json.dumps({
        "stage": "field_extraction",
        "raw_ocr_text_excerpt": redact_diagnostic_text(candidate_text[:4000]),
        "raw_ocr_characters": len(raw_text),
        "raw_ocr_sha256": hashlib.sha256(raw_text.encode("utf-8")).hexdigest(),
        "field_candidates_and_normalized_values": raw_candidates,
        "missing_required_fields": [
            canonical_field_id(spec.get("id")) for spec in schema
            if spec.get("required") and result.get(canonical_field_id(spec.get("id")), {}).get("value") is None
        ],
    }, ensure_ascii=False))
    return result


def field_aliases(name: Any) -> list[str]:
    canonical_name = canonical_field_id(name)
    return {
        "vendor_name": ["issuer", "issuer / vendor"],
        "buyer_name": ["recipient", "bill to / recipient", "billed to (client / organization)"],
        "invoice_date": ["issue date"],
        "purchase_order_reference": ["purchase order no", "purchase order number", "purchase order ref"],
        "currency": ["billing currency"],
        "tax_amount": ["sales tax amount", "state & local sales tax", "tax amount", "cgst", "sgst", "igst"],
        "tax_rate": ["tax rate", "gst rate", "rate (%)"],
        "total_amount": ["total amount due"],
    }.get(canonical_name, [])


def is_label_continuation(candidate: str) -> bool:
    return bool(re.match(
        r"^(?:[/&|]\s*|(?:financial|reconciliation|id|ein|registration|ref)\b|\([^)]*\)\s*[:#=-]?\s*$)",
        candidate.strip(),
        re.IGNORECASE,
    ))


def find_following_value(lines: list[str], line_index: int, aliases: list[str]) -> str | None:
    for following in lines[line_index + 1:]:
        candidate = following.strip()
        if not candidate:
            continue
        if is_field_label(candidate, aliases):
            return None
        return candidate
    return None


def find_following_money(lines: list[str], line_index: int, aliases: list[str]) -> str | None:
    for following in lines[line_index + 1:]:
        candidate = following.strip()
        if not candidate:
            continue
        if is_field_label(candidate, aliases):
            return None
        if normalize_money(candidate) is not None:
            return candidate
        if not is_label_continuation(candidate):
            return None
    return None


def extract_subtotal_components(pages: list[dict[str, Any]]) -> str | None:
    components: dict[str, Decimal] = {}
    label_pattern = re.compile(
        r"^\s*(?:(taxable|non[- ]taxable)\s+subtotal|subtotal\s*\(\s*(taxable|non[- ]taxable)\s*\))\s*:?\s*(.*?)\s*$",
        re.IGNORECASE,
    )
    for page in pages:
        lines = page["text"].splitlines()
        for index, line in enumerate(lines):
            match = label_pattern.match(line)
            if not match:
                continue
            category = (match.group(1) or match.group(2)).lower().replace(" ", "-")
            amount_text = match.group(3).strip()
            if not normalize_money(amount_text):
                following = find_following_money(lines, index, [])
                amount_text = following or ""
            normalized = normalize_money(amount_text)
            if normalized is not None:
                components[category] = Decimal(normalized)
    if "taxable" not in components or "non-taxable" not in components:
        return None
    return format(components["taxable"] + components["non-taxable"], "f")


def infer_vendor_from_header(text: str) -> str | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in reversed(lines):
        match = re.match(r"^(?:for|from)\s+(.+?)\s*[.!]?$", line, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    address_pattern = re.compile(
        r"^\d{1,6}\s+.*\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|way)\b",
        re.IGNORECASE,
    )
    for index, line in enumerate(lines[:8]):
        if index + 1 >= len(lines) or not address_pattern.match(lines[index + 1]):
            continue
        if ":" in line or re.search(r"\b(?:invoice|validated|bill(?:ed)? to|client|organization)\b", line, re.IGNORECASE):
            continue
        return line
    for line in lines[:6]:
        if re.search(r"\binvoice\b", line, re.IGNORECASE):
            candidate = re.sub(r"\binvoice\b.*$", "", line, flags=re.IGNORECASE).strip(" :-|")
            candidate = re.sub(r"^(?:[A-Z]{1,3}\s+)(?=[A-Z][a-z])", "", candidate)
            if len(candidate.split()) >= 2 and not re.search(r"\b(?:tax|bill|client|validated)\b", candidate, re.IGNORECASE):
                return candidate
    return None


def infer_currency(pages: list[dict[str, Any]]) -> tuple[str | None, str | None, bool]:
    text = "\n".join(page["text"] for page in pages)
    symbol_codes = {"₹": "INR", "$": "USD", "€": "EUR", "£": "GBP"}
    for symbol, currency in symbol_codes.items():
        if symbol in text:
            evidence = next(line.strip() for line in text.splitlines() if symbol in line)
            return currency, evidence, False
    currency_match = re.search(r"\b(INR|USD|EUR|GBP|CAD|AUD)\b", text, re.IGNORECASE)
    if currency_match:
        evidence = next(line.strip() for line in text.splitlines() if currency_match.group(0).lower() in line.lower())
        return currency_match.group(1).upper(), evidence, False
    ocr_rupee_marker = next(
        (line.strip() for line in text.splitlines() if re.match(r"^\s*[Il]\s*(?=\d)", line)),
        None,
    )
    if ocr_rupee_marker:
        return "INR", ocr_rupee_marker, True
    indian_evidence = [
        line.strip() for line in text.splitlines()
        if re.search(r"\bGSTIN\b|\bIndia\b|\bMaharashtra\b|\+91\b", line, re.IGNORECASE)
    ]
    if indian_evidence:
        return "INR", "Inferred from: " + "; ".join(indian_evidence[:3]), True
    return None, None, False


def extract_tax_rate(line: str) -> str | None:
    match = re.search(
        r"\b(?:GST|CGST|SGST|IGST|VAT|TAX)\b.{0,40}?(\d{1,2}(?:[.,]\d+)?\s*%)",
        line,
        re.IGNORECASE,
    )
    if not match:
        return None
    return re.sub(r"\s+", "", match.group(1))


def redact_diagnostic_text(value: str | None) -> str | None:
    if value is None:
        return None
    redacted = re.sub(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email]", value)
    redacted = re.sub(r"\+?\d[\d\s().-]{7,}\d", "[phone-or-account]", redacted)
    redacted = re.sub(r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]\b", "[tax-id]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\b(?:\d[ -]?){9,18}\b", "[long-number]", redacted)
    return redacted


def canonical_field_id(name: Any) -> Any:
    if not isinstance(name, str):
        return name
    normalized = re.sub(r"[\s-]+", "_", name.strip().lower())
    aliases = {
        "invoice_no": "invoice_number",
        "invoice_id": "invoice_number",
        "vendor": "vendor_name",
        "supplier": "vendor_name",
        "seller": "vendor_name",
        "buyer": "buyer_name",
        "customer": "buyer_name",
        "bill_to": "buyer_name",
        "invoice_dt": "invoice_date",
        "due_dt": "due_date",
        "sub_total": "subtotal",
        "tax": "tax_amount",
        "total_tax": "tax_amount",
        "gst": "tax_amount",
        "gst_amount": "tax_amount",
        "vat": "tax_amount",
        "vat_amount": "tax_amount",
        "discount_amount": "discount",
        "grand_total": "total_amount",
        "invoice_total": "total_amount",
        "total": "total_amount",
        "amount_due": "total_amount",
        "total_due": "total_amount",
        "balance_due": "total_amount",
    }
    return aliases.get(normalized, normalized)


def is_field_label(line: str, aliases: list[str]) -> bool:
    for alias in aliases:
        label = re.escape(alias).replace(r"\ ", r"\s+")
        match = re.match(rf"^\s*(?:[-*]\s*)?{label}(?:\s*[:#=-]\s*|\s*(?=[(/])|$)(.*?)\s*$", line, re.IGNORECASE)
        if match and not is_label_continuation(match.group(1)):
            return True
    return False


def strip_following_field_label(value: str, aliases: list[str]) -> str:
    cut_positions = []
    for alias in aliases:
        label = re.escape(alias).replace(r"\ ", r"\s+")
        match = re.search(rf"\s+{label}\s*[:#=-]\s*", value, re.IGNORECASE)
        if match:
            cut_positions.append(match.start())
    return value[:min(cut_positions)].strip() if cut_positions else value.strip()


def normalize_field_value(value: str, data_type: Any) -> str | None:
    if data_type == "date":
        return normalize_date(value)
    if data_type == "decimal":
        return normalize_money(value)
    return value.strip() or None


def normalize_currency(value: str) -> str:
    match = re.search(r"\b(INR|USD|EUR|GBP|CAD|AUD)\b", value, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    symbols = {"₹": "INR", "$": "USD", "€": "EUR", "£": "GBP"}
    return next((code for symbol, code in symbols.items() if symbol in value), value.strip())


def is_tax_identifier_candidate(value: str) -> bool:
    return bool(re.match(r"^(?:id\b|in\s*:|gstin\b|tin\b|vat\s*id\b|tax\s*id\b)", value.strip(), re.IGNORECASE))


def normalize_date(value: str) -> str | None:
    cleaned = re.split(r"\s*\(", value.strip(), maxsplit=1)[0].strip()
    cleaned = re.sub(r"^(?:date\s*[:#=-]?\s*)", "", cleaned, flags=re.IGNORECASE)
    formats = (
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%d-%b-%Y",
        "%d %b %Y",
        "%d %B %Y",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%d/%m/%y",
        "%d-%m-%y",
        "%b %d, %Y",
        "%B %d, %Y",
    )
    for date_format in formats:
        try:
            return datetime.strptime(cleaned, date_format).date().isoformat()
        except ValueError:
            continue
    return None


def normalize_money(value: str) -> str | None:
    cleaned = value.strip()
    negative = False
    if cleaned.startswith("(") and cleaned.endswith(")"):
        negative = True
        cleaned = cleaned[1:-1].strip()
    if "(" in cleaned or ")" in cleaned:
        return None
    cleaned = re.sub(r"^(?:rs\.?|inr|usd|eur|gbp)\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^(?:₹|[$£€])\s*", "", cleaned)
    cleaned = re.sub(r"^[Il]\s*(?=[\d(])", "", cleaned)
    cleaned = re.sub(r"\s*(?:inr|usd|eur|gbp|₹|[$£€])$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", "", cleaned)
    if not re.fullmatch(r"[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?", cleaned):
        return None
    if negative:
        if cleaned.startswith("-"):
            return None
        cleaned = f"-{cleaned}"
    normalized = cleaned.replace(",", "")
    try:
        Decimal(normalized)
    except InvalidOperation:
        return None
    return normalized


def is_percentage_candidate(value: str) -> bool:
    return bool(re.fullmatch(r"\(?\s*\d+(?:[.,]\d+)?\s*%\s*\)?", value.strip()))


def find_tax_amount(candidate: str, lines: list[str], line_index: int, aliases: list[str]) -> str | None:
    if ":" in candidate:
        amount_after_label = candidate.rsplit(":", 1)[-1].strip()
        if normalize_money(amount_after_label) is not None:
            return amount_after_label
    percentage_matches = list(re.finditer(r"\d+(?:[.,]\d+)?\s*%", candidate))
    if percentage_matches:
        trailing_text = candidate[percentage_matches[-1].end():].strip(" %:=;")
        amount_match = re.search(
            r"(?<![A-Za-z0-9])(?:₹|[$£€])?\s*\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])",
            trailing_text,
        )
        if amount_match:
            amount = amount_match.group(0).strip()
            if normalize_money(amount) is not None:
                return amount
    normalized = normalize_money(candidate)
    if normalized is not None:
        return candidate
    if not re.search(r"\d+(?:[.,]\d+)?\s*%", candidate):
        amount_match = re.search(r"(?<![A-Za-z0-9])(?:₹|[$£€])?\s*\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])", candidate)
        if amount_match:
            amount = amount_match.group(0).strip()
            if normalize_money(amount) is not None:
                return amount

    for next_line in lines[line_index + 1:]:
        following = next_line.strip()
        if not following:
            continue
        if is_field_label(following, aliases):
            break
        if re.search(r"\)\s*[:;]?\s*$", following):
            continue
        if normalize_money(following) is not None:
            return following
    return None


def is_decimal_candidate(value: str) -> bool:
    return normalize_money(value) is not None
