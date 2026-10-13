// Client-side resume checks. They mirror src/server/routes/resumes.js + src/domain/resumes.js so the
// operator gets instant feedback; the server stays the authority (magic bytes, size, name rules).

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
export const MAX_NAME_LENGTH = 80;

// Control characters and bidi overrides, as on the server.
const CONTROL = /[\p{Cc}‪-‮⁦-⁩]/u;

/** Null when the file is acceptable, otherwise the message to show. */
export function checkResumeFile(file: File | null | undefined): string | null {
  if (!file) return "Choose a PDF file.";
  const isPdfType = file.type === "application/pdf" || (file.type === "" && /\.pdf$/i.test(file.name));
  if (!isPdfType || !/\.pdf$/i.test(file.name)) return "The resume must be a PDF file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_RESUME_BYTES) return "The file is larger than 5 MB.";
  return null;
}

/** True when the file really starts with the PDF header (the name alone proves nothing). */
export function looksLikePdf(file: Blob): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      resolve(bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-");
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 5));
  });
}

export function checkResumeName(name: string): string | null {
  if (CONTROL.test(name)) return "The name must not contain control characters.";
  const t = name.trim();
  if (!t) return "A name is required.";
  if (t.length > MAX_NAME_LENGTH) return `The name must be at most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

export function defaultNameFor(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").trim().slice(0, MAX_NAME_LENGTH);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
