import unittest
from decimal import Decimal
from pathlib import Path

import pymupdf

from app import extract_fields, process_document


INVOICE_SCHEMA = [
    {"id": "invoice_number", "type": "string", "required": True, "aliases": ["invoice number", "invoice no"]},
    {"id": "vendor_name", "type": "string", "required": True, "aliases": ["supplier", "vendor", "issuer", "issuer / vendor"]},
    {"id": "buyer_name", "type": "string", "required": False, "aliases": ["buyer", "bill to", "bill to / recipient", "recipient"]},
    {"id": "invoice_date", "type": "date", "required": True, "aliases": ["invoice date", "issue date", "date"]},
    {"id": "due_date", "type": "date", "required": False, "aliases": ["payment due date", "due date"]},
    {"id": "subtotal", "type": "decimal", "required": False, "aliases": ["subtotal", "sub total"]},
    {"id": "tax_amount", "type": "decimal", "required": False, "aliases": ["tax amount", "total tax", "sales tax amount", "sales tax", "state & local sales tax", "gst amount", "vat amount", "cgst", "sgst", "igst", "tax", "vat", "gst"]},
    {"id": "tax_rate", "type": "string", "required": False, "aliases": ["tax rate", "gst rate", "rate (%)", "gst"]},
    {"id": "discount", "type": "decimal", "required": False, "aliases": ["discount"]},
    {"id": "total_amount", "type": "decimal", "required": True, "aliases": ["grand total", "total amount due", "total"]},
    {"id": "currency", "type": "string", "required": True, "aliases": ["currency", "billing currency"]},
    {"id": "purchase_order_reference", "type": "string", "required": False, "aliases": ["purchase order", "purchase order ref", "purchase order no", "purchase order number", "po number", "po #"]},
]


class OcrPipelineTests(unittest.TestCase):
    def test_actual_brightbyte_upload_extracts_invoice_fields_from_tesseract(self):
        fixture = Path(__file__).parent / "tests" / "fixtures" / "brightbyte_uploaded_invoice.jpg"
        content = fixture.read_bytes()
        pages, confidences, methods = process_document(content, "image/jpeg")
        fields = extract_fields(INVOICE_SCHEMA, pages, sum(confidences) / len(confidences), methods[0])

        self.assertEqual(methods, ["tesseract"])
        self.assertGreaterEqual(sum(confidences) / len(confidences), 40)
        self.assertEqual(fields["buyer_name"]["value"], "ABC Enterprises")
        self.assertEqual(fields["vendor_name"]["value"], "BrightByte Electronics")
        self.assertEqual(fields["invoice_number"]["value"], "BBE/2026-27/1042")
        self.assertEqual(fields["invoice_date"]["value"], "2026-10-18")
        self.assertEqual(fields["due_date"]["value"], "2026-11-01")
        self.assertEqual(fields["currency"]["value"], "INR")
        self.assertEqual(fields["subtotal"]["value"], "11550.00")
        self.assertEqual(fields["tax_rate"]["value"], "18%")
        self.assertEqual(fields["tax_amount"]["value"], "2079.00")
        self.assertEqual(fields["total_amount"]["value"], "13629.00")

    def test_embedded_pdf_text_is_extracted_before_ocr(self):
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((72, 72), "Invoice Number: INV-100\nSupplier: Example Supplies")
        content = document.tobytes()
        document.close()

        pages, confidences, methods = process_document(content, "application/pdf")
        fields = extract_fields(
            [
                {"id": "invoice_number", "type": "string", "aliases": ["invoice number"]},
                {"id": "vendor_name", "type": "string", "aliases": ["supplier"]},
                {"id": "total_amount", "type": "decimal", "aliases": ["total"]},
            ],
            pages,
            sum(confidences) / len(confidences),
            methods[0],
        )

        self.assertEqual(methods, ["embedded_text"])
        self.assertEqual(fields["invoice_number"]["value"], "INV-100")
        self.assertEqual(fields["vendor_name"]["value"], "Example Supplies")
        self.assertIsNone(fields["total_amount"]["value"])
        self.assertIsNone(fields["total_amount"]["page_number"])

    def test_text_invoice_pdf_extracts_fields_before_verification(self):
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text(
            (72, 72),
            "Invoice Number: INV-2026-42\n"
            "Supplier: Example Supplies\n"
            "Bill To: Example Buyer\n"
            "Invoice Date: 18-Oct-2026\n"
            "Due Date: 18/11/2026\n"
            "Subtotal: INR 1,234.50\n"
            "Tax: INR 222.21\n"
            "Grand Total: INR 1,456.71",
        )
        content = document.tobytes()
        document.close()

        pages, confidences, methods = process_document(content, "application/pdf")
        fields = extract_fields(INVOICE_SCHEMA, pages, sum(confidences) / len(confidences), methods[0])

        self.assertEqual(methods, ["embedded_text"])
        self.assertEqual(fields["invoice_number"]["value"], "INV-2026-42")
        self.assertEqual(fields["vendor_name"]["value"], "Example Supplies")
        self.assertEqual(fields["buyer_name"]["value"], "Example Buyer")
        self.assertEqual(fields["invoice_date"]["value"], "2026-10-18")
        self.assertEqual(fields["due_date"]["value"], "2026-11-18")
        self.assertEqual(fields["subtotal"]["value"], "1234.50")
        self.assertEqual(fields["tax_amount"]["value"], "222.21")
        self.assertEqual(fields["total_amount"]["value"], "1456.71")
        self.assertIsNone(fields["discount"]["value"])

    def test_decimal_field_ignores_tax_identifier_text_and_accepts_currency_amount(self):
        schema = [
            {"id": "tax_amount", "type": "decimal", "aliases": ["tax"]},
            {"id": "total_amount", "type": "decimal", "aliases": ["total"]},
        ]
        pages = [{
            "page": 1,
            "text": "Tax: IN: 27ABCDE1234F125\nTotal: INR 1,234.50",
        }]

        fields = extract_fields(schema, pages, 80.0, "tesseract")

        self.assertIsNone(fields["tax_amount"]["value"])
        self.assertEqual(fields["total_amount"]["value"], "1234.50")

    def test_invoice_extraction_normalizes_dates_money_and_currency_symbol(self):
        pages = [{
            "page": 1,
            "text": (
                "Invoice Number: INV-2026-42\n"
                "Supplier: Example Supplies\n"
                "Bill To: Example Buyer\n"
                "Invoice Date: 18-Oct-2026\n"
                "Due Date: 18/11/2026\n"
                "Subtotal: INR 1,234.50\n"
                "Tax: \u20b9 222.21\n"
                "Discount:\n"
                "Grand Total: \u20b9 1,456.71"
            ),
        }]

        fields = extract_fields(INVOICE_SCHEMA, pages, 90.0, "embedded_text")

        self.assertEqual(fields["invoice_date"]["value"], "2026-10-18")
        self.assertEqual(fields["due_date"]["value"], "2026-11-18")
        self.assertEqual(fields["subtotal"]["value"], "1234.50")
        self.assertEqual(fields["tax_amount"]["value"], "222.21")
        self.assertIsNone(fields["discount"]["value"])
        self.assertEqual(fields["total_amount"]["value"], "1456.71")
        self.assertEqual(fields["currency"]["value"], "INR")

    def test_brightbyte_sample_invoice_extracts_gst_amount_not_rate(self):
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text(
            (72, 72),
            "BrightByte Electronics\n"
            "Invoice No: BBE/2026-27/1042\n"
            "Invoice Date: 18-Oct-2026\n"
            "Subtotal\n"
            "I11,550.00\n"
            "GST (18%)\n"
            "I2,079.00\n"
            "Grand Total\n"
            "I13,629.00",
        )
        content = document.tobytes()
        document.close()

        pages, confidences, methods = process_document(content, "application/pdf")
        fields = extract_fields(INVOICE_SCHEMA, pages, sum(confidences) / len(confidences), methods[0])

        self.assertEqual(fields["subtotal"]["value"], "11550.00")
        self.assertEqual(fields["tax_amount"]["value"], "2079.00")
        self.assertEqual(fields["total_amount"]["value"], "13629.00")
        self.assertIsNone(fields["discount"]["value"])
        self.assertEqual(fields["currency"]["value"], "INR")

    def test_field_names_are_canonicalized_for_tax_and_total_aliases(self):
        schema = [
            {"id": "total_tax", "type": "decimal", "aliases": ["tax"]},
            {"id": "grand_total", "type": "decimal", "aliases": ["grand total"]},
        ]
        fields = extract_fields(
            schema,
            [{"page": 1, "text": "Tax: 18.00\nGrand Total: 118.00"}],
            90.0,
            "embedded_text",
        )

        self.assertEqual(fields["tax_amount"]["value"], "18.00")
        self.assertEqual(fields["total_amount"]["value"], "118.00")

    def test_apex_invoice_composite_labels_extract_names_and_amounts(self):
        pages = [{
            "page": 1,
            "text": (
                "TAX INVOICE\n"
                "ISSUER / VENDOR:\n"
                "Apex Cloud Solutions Inc.\n"
                "BILL TO / RECIPIENT:\n"
                "Global Enterprise Dynamics LLC\n"
                "Invoice Number: INV-2026-8842\n"
                "Invoice Date: October 15, 2026\n"
                "Payment Due Date: November 14, 2026\n"
                "Purchase Order No:\n"
                "PO-99201-B\n"
                "TAX & FINANCIAL RECONCILIATION:\n"
                "Taxable Subtotal: $2,840.00\n"
                "Non-Taxable Subtotal (Services): $900.00\n"
                "Subtotal: $3,740.00\n"
                "Sales Tax (8.25% on $2,840.00): $234.30\n"
                "TOTAL AMOUNT DUE: $3,974.30\n"
                "Currency: USD ($)"
            ),
        }]

        fields = extract_fields(INVOICE_SCHEMA, pages, 95.0, "embedded_text")

        self.assertEqual(fields["vendor_name"]["value"], "Apex Cloud Solutions Inc.")
        self.assertEqual(fields["buyer_name"]["value"], "Global Enterprise Dynamics LLC")
        self.assertEqual(fields["invoice_date"]["value"], "2026-10-15")
        self.assertEqual(fields["due_date"]["value"], "2026-11-14")
        self.assertEqual(fields["purchase_order_reference"]["value"], "PO-99201-B")
        self.assertEqual(fields["subtotal"]["value"], "3740.00")
        self.assertEqual(fields["tax_amount"]["value"], "234.30")
        self.assertEqual(fields["total_amount"]["value"], "3974.30")
        self.assertEqual(fields["currency"]["value"], "USD")

    def test_apex_systems_invoice_from_current_ocr_extracts_and_sums_components(self):
        pages = [{
            "page": 1,
            "text": (
                "APEX SYSTEMS & CLOUD LTD\n"
                "350 Mission Street, Suite 1900, San Francisco, CA 94105, USA\n"
                "Tax Registration / EIN: 84-2957103 • DUNS: 08-392-8149\n"
                "TAX INVOICE\n"
                "BILLED TO (CLIENT / ORGANIZATION)\n"
                "Meridian Global Logistics Corp.\n"
                "Accounts Payable Division\n"
                "Invoice Number:\n"
                "INV-2026-8842\n"
                "Issue Date:\n"
                "14 Oct 2026\n"
                "Due Date:\n"
                "13 Nov 2026 (Net 30)\n"
                "Purchase Order Ref: PO-99201-B\n"
                "Billing Currency:\n"
                "USD ($)\n"
                "FINANCIAL SUMMARY\n"
                "Subtotal (Taxable):\n"
                "$5,850.00\n"
                "Subtotal (Non-Taxable):\n"
                "$1,650.00\n"
                "State & Local Sales Tax (8.25% on\n"
                "$5,850):\n"
                "$482.63\n"
                "Standard Processing Fee:\n"
                "$0.00\n"
                "TOTAL AMOUNT DUE:\n"
                "$7,982.63\n"
                "Quarterly automated continuous vulnerability scan and vendor report"
            ),
        }]

        fields = extract_fields(INVOICE_SCHEMA, pages, 100.0, "embedded_text")

        self.assertEqual(fields["vendor_name"]["value"], "APEX SYSTEMS & CLOUD LTD")
        self.assertEqual(fields["buyer_name"]["value"], "Meridian Global Logistics Corp.")
        self.assertEqual(fields["invoice_number"]["value"], "INV-2026-8842")
        self.assertEqual(fields["invoice_date"]["value"], "2026-10-14")
        self.assertEqual(fields["due_date"]["value"], "2026-11-13")
        self.assertEqual(fields["purchase_order_reference"]["value"], "PO-99201-B")
        self.assertEqual(fields["currency"]["value"], "USD")
        self.assertEqual(fields["subtotal"]["value"], "7500.00")
        self.assertEqual(fields["tax_amount"]["value"], "482.63")
        self.assertEqual(fields["total_amount"]["value"], "7982.63")
        self.assertEqual(
            Decimal(fields["subtotal"]["value"]) + Decimal(fields["tax_amount"]["value"]),
            Decimal(fields["total_amount"]["value"]),
        )


if __name__ == "__main__":
    unittest.main()
