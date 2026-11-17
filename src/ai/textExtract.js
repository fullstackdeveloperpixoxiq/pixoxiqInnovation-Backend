import path from 'path';
import ApiError from '../utils/ApiError.js';

// Extracts plain text from uploaded knowledge documents. The file type is checked from its
// content (magic bytes), not only its name, and the original file is not kept: only the
// extracted text is stored.

const TYPES = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.csv': 'text',
  '.json': 'text',
  '.html': 'html',
  '.htm': 'html',
};

export const SUPPORTED_EXTENSIONS = Object.keys(TYPES);
export const MAX_TEXT_LENGTH = 1000000;

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));

const htmlToText = (html) =>
  decodeEntities(
    html
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
  );

// Removes control characters and normalises whitespace
export const cleanText = (text) =>
  String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const decodeUtf8 = (buffer) => {
  if (buffer.includes(0)) throw ApiError.badRequest('This file looks binary, not text');
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
};

export const extractText = async ({ buffer, originalname }) => {
  const ext = path.extname(originalname || '').toLowerCase();
  const type = TYPES[ext];
  if (!type) throw ApiError.badRequest(`Unsupported file type. Allowed: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  if (!buffer?.length) throw ApiError.badRequest('The file is empty');

  let text = '';
  if (type === 'pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw ApiError.badRequest('This file is not a valid PDF');
    const { getDocumentProxy, extractText: extractPdf } = await import('unpdf');
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractPdf(pdf, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
    } catch (err) {
      throw ApiError.badRequest(`Could not read the PDF: ${err.message}`);
    } finally {
      pdf?.destroy?.();
    }
  } else if (type === 'docx') {
    if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw ApiError.badRequest('This file is not a valid DOCX document');
    const mammoth = (await import('mammoth')).default;
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } catch (err) {
      throw ApiError.badRequest(`Could not read the DOCX document: ${err.message}`);
    }
  } else if (type === 'html') {
    text = htmlToText(decodeUtf8(buffer));
  } else {
    text = decodeUtf8(buffer);
  }

  text = cleanText(text);
  if (!text) {
    throw ApiError.badRequest(
      type === 'pdf'
        ? 'No text found in this PDF. Scanned (image-only) PDFs need OCR before they can be added.'
        : 'No text found in this file'
    );
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw ApiError.badRequest(`The document contains too much text (${text.length.toLocaleString()} characters, max ${MAX_TEXT_LENGTH.toLocaleString()}). Split it into smaller files.`);
  }
  return text;
};
