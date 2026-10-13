import { describe, expect, it } from "vitest";
import { fillTemplate, validateTemplate } from "./template";

const values = { person: "Jo Smith", role: "SWE Intern", company: "Acme", subject: "SWE role" };

describe("fillTemplate (mirrors src/domain/template.js)", () => {
  it("fills known placeholders, first name from person, unknown ones empty", () => {
    expect(fillTemplate("Hi {{firstName}} ({{ person }}) re {{role}} at {{company}}: {{subject}}{{nope}}.", values)).toBe(
      "Hi Jo (Jo Smith) re SWE Intern at Acme: SWE role.",
    );
  });
  it("never re-expands placeholders inside values", () => {
    expect(fillTemplate("{{company}}", { ...values, company: "{{person}}" })).toBe("{{person}}");
  });
});

describe("validateTemplate", () => {
  it("requires a one-line subject up to 200 chars and a body up to 5000", () => {
    expect(validateTemplate({ subject: "Re: {{subject}}", body: "Hi" })).toEqual({});
    expect(validateTemplate({ subject: " ", body: "" })).toMatchObject({ subject: expect.any(String), body: expect.any(String) });
    expect(validateTemplate({ subject: "a\nb", body: "x" }).subject).toMatch(/line break/i);
    expect(validateTemplate({ subject: "a".repeat(201), body: "x" }).subject).toMatch(/200/);
    expect(validateTemplate({ subject: "a", body: "x".repeat(5001) }).body).toMatch(/5000/);
  });
});
