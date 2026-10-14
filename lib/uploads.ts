// What an uploaded file has to be before anything parses it (design §9.1). Owner: platform.
//
// Three gates, in this order, all before a parser sees the bytes:
//   1. Size. 20 MB. Checked against the multipart file's declared size, so a 300 MB export is refused
//      without reading it into memory.
//   2. Shape. Magic bytes first (zip, gzip, PDF, images), then a NUL scan, so a compressed or binary file is
//      named for what it is instead of failing deep inside a CSV parser.
//   3. Format against the kind. Clarity, WHOOP and the hand-labelled visits file are CSV; a Google Maps
//      Timeline export is JSON. A JSON file sent as a Dexcom upload is a wrong-button mistake, not a parse error.
//
// Every refusal is one plain sentence, lowercase, no trailing period: the patient page prints it inside
// "That file didn't work: <reason>. Want to try again, or ask me how to export it?", and Sweetie reads it
// aloud (§6.1). So it says what to do next, not what the parser disliked.

import type { UploadKind } from "./types";

/** §9.1. A 7-day Clarity export is about 100 kB, so this is two orders of magnitude of headroom. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** How many bytes of the head are enough to tell what a file is. */
const SNIFF_WINDOW = 4096;

export type UploadFormat = "csv" | "json";

/** The format each kind of upload comes in (§9.1, §9.3). */
export function formatFor(kind: UploadKind): UploadFormat {
  return kind === "timeline" ? "json" : "csv";
}

/** What the patient calls the file, for the wrong-format sentences. */
const SOURCE: Record<UploadKind, string> = {
  dexcom: "a Dexcom Clarity export",
  timeline: "a Google Maps Timeline export",
  whoop: "a WHOOP export",
  visits: "the places file",
};

export type UploadCheck = { ok: true; format: UploadFormat } | { ok: false; reason: string };

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Gate 1, on its own because it runs before the bytes are read. */
export function checkSize(bytes: number): UploadCheck | null {
  if (bytes <= 0) return { ok: false, reason: "that file is empty" };
  if (bytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `that file is ${megabytes(bytes)} and the most we can take is ${megabytes(MAX_UPLOAD_BYTES)} — exporting a shorter date range, like the last 7 days, is plenty`,
    };
  }
  return null;
}

/** A container or a binary, named by its first bytes. Null means "looks like text". */
function containerType(head: Uint8Array): string | null {
  const is = (...sig: number[]) => sig.every((b, i) => head[i] === b);
  if (is(0x50, 0x4b)) return "zip"; // also xlsx, docx, and the zipped Takeout folder
  if (is(0x1f, 0x8b)) return "gzip";
  if (is(0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (is(0x89, 0x50, 0x4e, 0x47)) return "image";
  if (is(0xff, 0xd8, 0xff)) return "image";
  if (is(0x42, 0x5a, 0x68)) return "bzip2";
  if (is(0xfd, 0x37, 0x7a, 0x58, 0x5a)) return "xz";
  if (is(0xd0, 0xcf, 0x11, 0xe0)) return "office"; // .xls, .doc
  return null;
}

const UNPACK: Record<string, string> = {
  zip: "that looks like a zip file — unzip it and upload the file inside",
  gzip: "that looks like a compressed file — uncompress it and upload the file inside",
  bzip2: "that looks like a compressed file — uncompress it and upload the file inside",
  xz: "that looks like a compressed file — uncompress it and upload the file inside",
  pdf: "that looks like a PDF — we need the data export, not a printed report",
  image: "that looks like a picture — we need the data export file",
  office: "that looks like a spreadsheet — export it as CSV and upload that",
};

/** Is this text at all? Decoded text keeps U+FFFD where the bytes were not valid UTF-8. */
function looksBinary(head: Uint8Array, text: string): boolean {
  if (head.includes(0x00)) return true;
  const replacements = (text.match(/�/g) ?? []).length;
  return replacements > 0 && replacements / Math.max(text.length, 1) > 0.01;
}

/** CSV or JSON, by the first thing that is not whitespace or a byte-order mark. */
function structuralFormat(text: string): UploadFormat | null {
  const first = text.replace(/^﻿/, "").trimStart()[0];
  if (!first) return null;
  if (first === "{" || first === "[") return "json";
  return "csv";
}

/**
 * Gates 2 and 3. `bytes` may be the whole file or just its head; only the first few kB are read.
 * Returns the format the file is in, which is what decides the stored object's content type.
 */
export function sniffUpload(kind: UploadKind, bytes: Uint8Array): UploadCheck {
  const head = bytes.subarray(0, SNIFF_WINDOW);
  const container = containerType(head);
  if (container) return { ok: false, reason: UNPACK[container] };

  const text = new TextDecoder("utf-8").decode(head);
  if (looksBinary(head, text)) return { ok: false, reason: `that does not look like a text file — ${SOURCE[kind]} is a ${formatFor(kind).toUpperCase()} file` };

  const format = structuralFormat(text);
  if (!format) return { ok: false, reason: "that file is empty" };

  const wanted = formatFor(kind);
  if (format !== wanted) {
    return {
      ok: false,
      reason:
        wanted === "csv"
          ? `that looks like a JSON file, but ${SOURCE[kind]} is a CSV — pick the .csv file`
          : `that looks like a CSV, but ${SOURCE[kind]} is a JSON file — pick the .json file`,
    };
  }
  return { ok: true, format };
}

/** Both gates in the order a route runs them: declared size first, then the head of the file. */
export function checkUpload(kind: UploadKind, declaredBytes: number, bytes: Uint8Array): UploadCheck {
  return checkSize(declaredBytes) ?? sniffUpload(kind, bytes);
}

/**
 * The same refusal as a sentence that can stand on its own. The chat page splices the reason into a longer
 * line, so the reasons are written lowercase; the intake page prints it on a card by itself, where a
 * lowercase start reads as a typo.
 */
export function asSentence(reason: string): string {
  const text = reason.trim();
  if (!text) return text;
  return `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}

/** The content type stored alongside the object. */
export function contentTypeFor(format: UploadFormat): string {
  return format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8";
}
