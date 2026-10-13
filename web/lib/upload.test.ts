import { describe, expect, it } from "vitest";
import { checkCsvFile, MAX_UPLOAD_BYTES } from "./upload";

const file = (name: string, size: number, type = "text/csv") => new File([new Uint8Array(size)], name, { type });

describe("checkCsvFile (mirrors the backend's 1MB .csv limit)", () => {
  it("accepts a .csv up to 1MB", () => {
    expect(checkCsvFile(file("leads.CSV", 10))).toBeNull();
    expect(checkCsvFile(file("leads.csv", MAX_UPLOAD_BYTES))).toBeNull();
  });
  it("rejects other extensions, empty files and files over 1MB", () => {
    expect(checkCsvFile(file("leads.xlsx", 10))).toMatch(/\.csv/);
    expect(checkCsvFile(file("leads.csv", 0))).toMatch(/empty/i);
    expect(checkCsvFile(file("leads.csv", MAX_UPLOAD_BYTES + 1))).toMatch(/1 MB/);
  });
});
