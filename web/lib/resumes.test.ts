import { describe, expect, it } from "vitest";
import { checkResumeFile, checkResumeName, defaultNameFor, formatBytes, looksLikePdf, MAX_RESUME_BYTES } from "./resumes";

const file = (bytes: BlobPart, name = "cv.pdf", type = "application/pdf") => new File([bytes], name, { type });

describe("resume client-side checks (mirror the server limits; the server stays the authority)", () => {
  it("accepts a normal PDF", () => {
    expect(checkResumeFile(file("%PDF-1.4 x"))).toBeNull();
  });
  it("rejects no file, empty file, over 5 MB, and non-PDF names/types", () => {
    expect(checkResumeFile(null)).toMatch(/choose/i);
    expect(checkResumeFile(file(""))).toMatch(/empty/i);
    expect(checkResumeFile(file(new Uint8Array(MAX_RESUME_BYTES + 1)))).toMatch(/5 MB/);
    expect(checkResumeFile(file(new Uint8Array(MAX_RESUME_BYTES)))).toBeNull();
    expect(checkResumeFile(file("%PDF-", "cv.docx", "application/msword"))).toMatch(/PDF/);
    expect(checkResumeFile(file("%PDF-", "cv.txt", "text/plain"))).toMatch(/PDF/);
  });
  it("accepts a .pdf name even when the browser gives no type", () => {
    expect(checkResumeFile(file("%PDF-1", "cv.pdf", ""))).toBeNull();
  });
  it("looks at the real header, not the name", async () => {
    expect(await looksLikePdf(file("%PDF-1.7\n"))).toBe(true);
    expect(await looksLikePdf(file("hello %PDF-"))).toBe(false);
  });
  it("display name: 1-80 chars, no control characters", () => {
    expect(checkResumeName("General SWE")).toBeNull();
    expect(checkResumeName("   ")).toMatch(/required|name/i);
    expect(checkResumeName("x".repeat(81))).toMatch(/80/);
    expect(checkResumeName("x".repeat(80))).toBeNull();
    expect(checkResumeName("a\tb")).toMatch(/control/i);
    expect(checkResumeName("a‮b")).toMatch(/control/i);
  });
  it("suggests a display name from the file name", () => {
    expect(defaultNameFor("Harsh Khamkar - Backend.PDF")).toBe("Harsh Khamkar - Backend");
    expect(defaultNameFor("x".repeat(120) + ".pdf")).toHaveLength(80);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
