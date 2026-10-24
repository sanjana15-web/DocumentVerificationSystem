'use strict';

const DOCUMENT_TYPES = [
  {
    id: 'invoice',
    name: 'Invoice',
    category: 'Business documents',
    schemaVersion: '1.0',
    authenticity: 'No trusted authenticity source is configured; reviewer verification is required.',
    fields: [
      field('invoice_number', 'Invoice number', 'string', true, ['invoice number', 'invoice no', 'invoice #', 'invoice id']),
      field('vendor_name', 'Supplier name', 'string', true, ['supplier name', 'supplier', 'vendor name', 'vendor', 'seller', 'bill from', 'issuer', 'issuer / vendor']),
      field('buyer_name', 'Buyer name', 'string', false, ['buyer name', 'buyer', 'bill to', 'bill to / recipient', 'recipient', 'billed to', 'billed to (client / organization)', 'customer']),
      field('invoice_date', 'Invoice date', 'date', true, ['invoice date', 'issue date', 'date of invoice', 'dated', 'date']),
      field('due_date', 'Due date', 'date', false, ['payment due date', 'due date']),
      field('subtotal', 'Subtotal', 'decimal', false, ['subtotal', 'sub total', 'net amount']),
      field('tax_amount', 'Tax', 'decimal', false, ['tax amount', 'total tax', 'sales tax amount', 'sales tax', 'state & local sales tax', 'gst amount', 'vat amount', 'cgst', 'sgst', 'igst', 'tax', 'vat', 'gst']),
      field('tax_rate', 'Tax rate', 'string', false, ['tax rate', 'gst rate', 'rate (%)']),
      field('discount', 'Discount', 'decimal', false, ['discount']),
      field('total_amount', 'Total', 'decimal', true, ['grand total', 'invoice total', 'amount payable', 'total amount due', 'total amount', 'amount due', 'total due', 'balance due', 'total']),
      field('currency', 'Currency', 'string', true, ['currency', 'billing currency']),
      field('purchase_order_reference', 'Purchase order reference', 'string', false, ['purchase order', 'purchase order ref', 'purchase order no', 'purchase order number', 'po number', 'po #']),
    ],
  },
  {
    id: 'receipt', name: 'Receipt', category: 'Business documents', schemaVersion: '1.0',
    authenticity: 'No trusted authenticity source is configured; reviewer verification is required.',
    fields: [
      field('receipt_number', 'Receipt number', 'string', false, ['receipt number', 'receipt no']),
      field('merchant_name', 'Merchant name', 'string', true, ['merchant', 'seller', 'vendor']),
      field('receipt_date', 'Receipt date', 'date', true, ['date', 'transaction date']),
      field('total_amount', 'Total', 'decimal', true, ['total', 'amount paid', 'grand total']),
      field('currency', 'Currency', 'string', false, ['currency']),
    ],
  },
  {
    id: 'credit_note', name: 'Credit note', category: 'Business documents', schemaVersion: '1.0',
    authenticity: 'No trusted authenticity source is configured; reviewer verification is required.',
    fields: [
      field('credit_note_number', 'Credit note number', 'string', true, ['credit note number', 'credit note no']),
      field('vendor_name', 'Supplier name', 'string', true, ['supplier', 'vendor']),
      field('issue_date', 'Issue date', 'date', true, ['issue date', 'date']),
      field('total_amount', 'Credit total', 'decimal', true, ['total', 'credit amount', 'grand total']),
      field('currency', 'Currency', 'string', false, ['currency']),
    ],
  },
  {
    id: 'academic_marksheet', name: 'Mark sheet / transcript', category: 'Education', schemaVersion: '1.0',
    authenticity: 'Academic authenticity is not checked without an authorized institutional reference.',
    fields: [
      field('student_name', 'Student name', 'string', true, ['student name', 'name of student', 'candidate name']),
      field('institution_name', 'Institution', 'string', true, ['institution', 'school', 'university', 'college']),
      field('examination_name', 'Examination', 'string', true, ['examination', 'exam', 'course']),
      field('roll_number', 'Roll / registration number', 'string', false, ['roll number', 'roll no', 'registration number']),
      field('academic_year', 'Academic year', 'string', false, ['academic year', 'year']),
      field('total_marks', 'Total marks', 'decimal', false, ['total marks', 'marks obtained']),
      field('maximum_marks', 'Maximum marks', 'decimal', false, ['maximum marks', 'max marks', 'out of']),
      field('percentage', 'Percentage', 'decimal', false, ['percentage', 'percent']),
      field('cgpa', 'CGPA', 'decimal', false, ['cgpa', 'grade point average']),
      field('result_status', 'Result', 'string', false, ['result', 'result status']),
      field('issue_date', 'Issue date', 'date', false, ['issue date', 'date of issue']),
    ],
  },
  {
    id: 'degree_certificate', name: 'Degree / educational certificate', category: 'Education', schemaVersion: '1.0',
    authenticity: 'Certificate authenticity is not checked without an authorized institutional reference.',
    fields: [
      field('recipient_name', 'Recipient name', 'string', true, ['awarded to', 'conferred upon', 'recipient', 'name']),
      field('institution_name', 'Institution', 'string', true, ['university', 'institution', 'college']),
      field('qualification', 'Qualification', 'string', true, ['degree', 'qualification', 'certificate']),
      field('specialization', 'Specialization', 'string', false, ['specialization', 'major', 'in']),
      field('issue_date', 'Issue date', 'date', false, ['issue date', 'dated']),
      field('certificate_number', 'Certificate number', 'string', false, ['certificate number', 'certificate no']),
    ],
  },
  {
    id: 'bonafide_certificate', name: 'Bonafide certificate', category: 'Education', schemaVersion: '1.0',
    authenticity: 'Certificate authenticity requires manual review unless an authorized reference is configured.',
    fields: [
      field('student_name', 'Student name', 'string', true, ['student name', 'certify that', 'this is to certify']),
      field('institution_name', 'Institution', 'string', true, ['institution', 'school', 'college', 'university']),
      field('issue_date', 'Issue date', 'date', false, ['date', 'issue date']),
      field('certificate_number', 'Certificate number', 'string', false, ['certificate number', 'reference number']),
    ],
  },
  {
    id: 'experience_certificate', name: 'Experience certificate', category: 'Employment', schemaVersion: '1.0',
    authenticity: 'Certificate authenticity requires manual review unless an authorized reference is configured.',
    fields: [
      field('employee_name', 'Employee name', 'string', true, ['employee name', 'this is to certify', 'mr.', 'ms.']),
      field('employer_name', 'Employer', 'string', true, ['employer', 'company', 'organization']),
      field('role', 'Role / position', 'string', false, ['designation', 'position', 'worked as']),
      field('start_date', 'Start date', 'date', false, ['from', 'start date', 'joined']),
      field('end_date', 'End date', 'date', false, ['to', 'end date', 'until']),
      field('issue_date', 'Issue date', 'date', false, ['issue date', 'date']),
    ],
  },
  {
    id: 'application_form', name: 'General application form', category: 'Forms', schemaVersion: '1.0',
    authenticity: 'Application contents and signatures require human review.',
    fields: [
      field('applicant_name', 'Applicant name', 'string', true, ['applicant name', 'name of applicant', 'name']),
      field('application_number', 'Application number', 'string', false, ['application number', 'application no', 'reference number']),
      field('application_date', 'Application date', 'date', true, ['application date', 'date']),
      field('requested_service', 'Requested service / purpose', 'string', false, ['purpose', 'service requested', 'subject']),
    ],
  },
  {
    id: 'permission_letter', name: 'Permission letter', category: 'Forms', schemaVersion: '1.0',
    authenticity: 'Permission and signature validity require human review.',
    fields: [
      field('applicant_name', 'Applicant name', 'string', true, ['applicant', 'name']),
      field('recipient_name', 'Recipient', 'string', false, ['to', 'recipient']),
      field('purpose', 'Purpose', 'string', true, ['subject', 'purpose', 'permission for']),
      field('issue_date', 'Issue date', 'date', true, ['date']),
    ],
  },
  {
    id: 'declaration_form', name: 'Declaration form', category: 'Forms', schemaVersion: '1.0',
    authenticity: 'Declaration and signature validity require human review.',
    fields: [
      field('declarant_name', 'Declarant name', 'string', true, ['declarant', 'name']),
      field('declaration_text', 'Declaration', 'string', true, ['declare', 'declaration']),
      field('issue_date', 'Date', 'date', true, ['date']),
    ],
  },
  {
    id: 'identity_document', name: 'Identity document', category: 'Identity', schemaVersion: '1.0',
    authenticity: 'Identity authenticity is not checked; manually verify against an authorized source.',
    fields: [
      field('document_type', 'Document type', 'string', true, ['passport', 'identity card', 'identity document']),
      field('full_name', 'Name', 'string', true, ['name', 'holder']),
      field('document_number', 'Document number', 'string', false, ['document number', 'id number', 'passport no']),
      field('issue_date', 'Issue date', 'date', false, ['issue date']),
      field('expiry_date', 'Expiry date', 'date', false, ['expiry date', 'expiration date', 'valid until']),
    ],
  },
  {
    id: 'address_proof', name: 'Address proof', category: 'Identity', schemaVersion: '1.0',
    authenticity: 'Address authenticity is not checked; manually verify against an authorized source.',
    fields: [
      field('full_name', 'Name', 'string', true, ['name', 'account holder']),
      field('address', 'Address', 'string', true, ['address', 'residential address']),
      field('document_date', 'Document date', 'date', false, ['date', 'statement date']),
      field('document_number', 'Document number', 'string', false, ['account number', 'reference number']),
    ],
  },
  {
    id: 'purchase_order', name: 'Purchase order', category: 'Business documents', schemaVersion: '1.0',
    authenticity: 'Purchase order references are checked only when trusted reference data exists.',
    fields: [
      field('purchase_order_number', 'Purchase order number', 'string', true, ['purchase order number', 'po number', 'po #']),
      field('supplier_name', 'Supplier', 'string', true, ['supplier', 'vendor']),
      field('buyer_name', 'Buyer', 'string', false, ['buyer', 'bill to']),
      field('order_date', 'Order date', 'date', true, ['order date', 'date']),
      field('total_amount', 'Total', 'decimal', true, ['total', 'grand total', 'amount']),
      field('currency', 'Currency', 'string', false, ['currency']),
    ],
  },
  {
    id: 'business_document', name: 'Other business document', category: 'Business documents', schemaVersion: '1.0',
    authenticity: 'No trusted authenticity source is configured; reviewer verification is required.',
    fields: [
      field('document_title', 'Document title', 'string', true, ['title', 'document']),
      field('organization_name', 'Organization', 'string', false, ['organization', 'company']),
      field('document_date', 'Document date', 'date', false, ['date']),
      field('reference_number', 'Reference number', 'string', false, ['reference number', 'reference no']),
    ],
  },
  {
    id: 'other', name: 'Other official document', category: 'Other', schemaVersion: '1.0',
    authenticity: 'No authenticity check is available for this type; manual review is required.',
    fields: [
      field('document_title', 'Document title', 'string', true, ['title', 'document']),
      field('issue_date', 'Issue date', 'date', false, ['issue date', 'date']),
      field('reference_number', 'Reference number', 'string', false, ['reference number', 'reference no']),
    ],
  },
];

function field(id, label, type, required, aliases) {
  return { id, label, type, required, aliases };
}

function getDocumentType(id) {
  return DOCUMENT_TYPES.find(type => type.id === id) || DOCUMENT_TYPES.find(type => type.id === 'other');
}

function validateFields(typeId, fields, { confidenceThreshold = 40, schema: configuredSchema = null } = {}) {
  const schema = configuredSchema || getDocumentType(typeId);
  const results = [];
  const getField = name => fields[name] || fields[canonicalFieldId(name)] ||
    Object.entries(fields).find(([fieldName]) => canonicalFieldId(fieldName) === canonicalFieldId(name))?.[1];
  const getValue = name => String(getField(name)?.field_value ?? '').trim();

  for (const spec of schema.fields) {
    const value = getValue(spec.id);
    if (spec.required && !value) {
      results.push(result(`REQUIRED_${spec.id.toUpperCase()}`, `Required field: ${spec.label}`, 'FAIL',
        `${spec.label} is missing.`, [spec.id]));
      continue;
    }
    if (!value) continue;

    if (spec.type === 'date' && !parseDate(value)) {
      results.push(result(`DATE_${spec.id.toUpperCase()}`, `Valid date: ${spec.label}`, 'FAIL',
        `${spec.label} was extracted but has an invalid date format. Use a real date such as DD-Mon-YYYY, DD/MM/YYYY, or YYYY-MM-DD.`,
        [spec.id], value));
    }
    if (spec.type === 'decimal' && parseDecimal(value) === null) {
      results.push(result(`NUMBER_${spec.id.toUpperCase()}`, `Numeric value: ${spec.label}`, 'FAIL',
        `${spec.label} was extracted but has an invalid monetary format. Use a number such as 1234.50, optionally with a currency symbol or code.`,
        [spec.id], value));
    }
    const confidenceValue = getField(spec.id)?.confidence;
    const confidence = confidenceValue === null || confidenceValue === undefined ? NaN : Number(confidenceValue);
    if (Number.isFinite(confidence) && confidence >= 0 && confidence < confidenceThreshold) {
      results.push(result(`CONFIDENCE_${spec.id.toUpperCase()}`, `OCR confidence: ${spec.label}`, 'NEEDS_REVIEW',
        `${spec.label} has low extraction confidence (${confidence.toFixed(1)}%). Confirm it against the original.`,
        [spec.id], String(confidence), `${confidenceThreshold}% or higher`));
    }
  }

  if (typeId === 'invoice') {
    const invoiceDateValue = getValue('invoice_date');
    const normalizedInvoiceDate = parseDate(invoiceDateValue);
    if (normalizedInvoiceDate) {
      const [year, month, day] = normalizedInvoiceDate.split('-').map(Number);
      const invoiceDay = Date.UTC(year, month - 1, day);
      const now = new Date();
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (invoiceDay > today) {
        results.push(result('INVOICE_DATE_FUTURE', 'Invoice date is not in the future', 'FAIL',
          'The invoice date is later than today.', ['invoice_date'], invoiceDateValue, 'Today or earlier'));
      }
    }
  }

  if (['invoice', 'credit_note'].includes(typeId)) {
    const subtotal = parseDecimal(getValue('subtotal'));
    const rawTax = getValue('tax_amount');
    const rawDiscount = getValue('discount');
    const taxValue = parseDecimal(rawTax);
    const discountValue = parseDecimal(rawDiscount);
    const tax = taxValue ?? 0;
    const discount = discountValue ?? 0;
    const total = parseDecimal(getValue('total_amount'));
    const expectedTotal = subtotal === null ? null : Math.round((subtotal + tax - discount) * 100) / 100;
    const optionalAmountsValid = (!rawTax || taxValue !== null) && (!rawDiscount || discountValue !== null);
    if (expectedTotal !== null && total !== null && optionalAmountsValid &&
        Math.abs(expectedTotal - total) > 0.02) {
      results.push(result('AMOUNT_CONSISTENCY', 'Subtotal, tax and discount match total', 'FAIL',
        `Invoice total equation does not balance: ${subtotal.toFixed(2)} + ${tax.toFixed(2)} - ${discount.toFixed(2)} = ${expectedTotal.toFixed(2)}, but the extracted total is ${total.toFixed(2)}.`,
        ['subtotal', 'tax_amount', 'discount', 'total_amount'], total.toFixed(2),
        `${subtotal.toFixed(2)} + ${tax.toFixed(2)} - ${discount.toFixed(2)} = ${expectedTotal.toFixed(2)}`));
    }
  }

  if (typeId === 'academic_marksheet') {
    const marks = parseDecimal(getValue('total_marks'));
    const maximum = parseDecimal(getValue('maximum_marks'));
    const percentage = parseDecimal(getValue('percentage'));
    if (marks !== null && maximum !== null && marks > maximum) {
      results.push(result('MARKS_RANGE', 'Obtained marks do not exceed maximum marks', 'FAIL',
        'Total marks exceed the configured maximum marks.', ['total_marks', 'maximum_marks'], String(marks), `<= ${maximum}`));
    } else if (marks !== null && maximum !== null && maximum > 0 && percentage !== null) {
      const expected = marks / maximum * 100;
      if (Math.abs(expected - percentage) > 0.5) {
        results.push(result('PERCENTAGE_CONSISTENCY', 'Percentage matches marks', 'WARNING',
          'The extracted percentage does not match total marks and maximum marks.', ['total_marks', 'maximum_marks', 'percentage'],
          String(percentage), expected.toFixed(2)));
      }
    }
  }

  results.push(result('AUTHENTICITY_MANUAL_REVIEW', 'Authenticity requires human review', 'NEEDS_REVIEW',
    schema.description || schema.authenticity, []));
  const schemaVersion = schema.schema_version || schema.schemaVersion || '1.0';
  return results.map(item => ({ ...item, ruleVersion: schemaVersion }));
}

function parseDecimal(value) {
  const normalized = normalizeDecimal(value);
  if (normalized === null) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeDecimal(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  let normalized = String(value).trim();
  let negative = false;
  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    negative = true;
    normalized = normalized.slice(1, -1).trim();
  }
  if (/[()]/.test(normalized)) return null;
  normalized = normalized.replace(/^(?:rs\.?|inr|usd|eur|gbp)\s*/i, '');
  normalized = normalized.replace(/^[₹$£€]\s*/, '');
  normalized = normalized.replace(/^[Il]\s*(?=[\d(])/, '');
  normalized = normalized.replace(/\s*(?:inr|usd|eur|gbp|₹|[$£€])$/i, '');
  normalized = normalized.replace(/\s+/g, '');
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(normalized)) return null;
  normalized = normalized.replace(/,/g, '');
  if (negative) {
    if (normalized.startsWith('-')) return null;
    normalized = `-${normalized}`;
  }
  return Number.isFinite(Number(normalized)) ? normalized : null;
}

function parseDate(value) {
  if (value === null || value === undefined) return null;
  const input = String(value).trim();
  let match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return validatedDate(match[1], match[2], match[3]);

  match = input.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (match) return validatedDate(match[3], match[2], match[1]);

  match = input.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4})$/);
  if (match) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = monthNames.findIndex(name => name === match[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return validatedDate(match[3], month, match[1]);
  }
  return null;
}

function validatedDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function canonicalFieldId(name) {
  const normalized = String(name).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    invoice_no: 'invoice_number', invoice_id: 'invoice_number',
    vendor: 'vendor_name', supplier: 'vendor_name', seller: 'vendor_name',
    buyer: 'buyer_name', customer: 'buyer_name', bill_to: 'buyer_name',
    invoice_dt: 'invoice_date', due_dt: 'due_date',
    sub_total: 'subtotal',
    tax: 'tax_amount', total_tax: 'tax_amount', gst: 'tax_amount',
    gst_amount: 'tax_amount', vat: 'tax_amount', vat_amount: 'tax_amount',
    discount_amount: 'discount',
    grand_total: 'total_amount', invoice_total: 'total_amount', total: 'total_amount',
    amount_due: 'total_amount', total_due: 'total_amount', balance_due: 'total_amount',
  };
  return aliases[normalized] || normalized;
}

function result(ruleId, ruleName, status, explanation, affectedFields, actualValue = null, expectedValue = null) {
  return {
    ruleId, ruleName, ruleVersion: '1.0', status, severity: status === 'FAIL' ? 'high' : 'medium',
    explanation, affectedFields, actualValue, expectedValue,
  };
}

module.exports = { DOCUMENT_TYPES, getDocumentType, validateFields, parseDecimal, normalizeDecimal, parseDate, canonicalFieldId };
