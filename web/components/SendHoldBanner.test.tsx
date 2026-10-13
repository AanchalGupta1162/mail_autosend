import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SendHoldBanner } from "./SendHoldBanner";

describe("SendHoldBanner", () => {
  it("a credential/config hold says all sending is paused and retried about every 15 minutes", () => {
    render(<SendHoldBanner hold={{ at: "2030-01-01T00:00:00Z", code: "EAUTH", message: "x" }} />);
    const t = screen.getByRole("alert").textContent ?? "";
    expect(t).toMatch(/Sending paused/);
    expect(t).toMatch(/credentials or configuration/);
    expect(t).toMatch(/about every 15 minutes/);
    expect(t).not.toMatch(/resumes by itself/);
  });

  it("a resume-scoped hold concerns one message and says other emails keep sending", () => {
    render(<SendHoldBanner hold={{ at: "2030-01-01T00:00:00Z", code: "ERESUME", message: "x", scope: "resume", messageId: "m" }} />);
    const t = screen.getByRole("alert").textContent ?? "";
    expect(t).toMatch(/message is on hold/);
    expect(t).toMatch(/Other emails keep sending/);
    expect(t).not.toMatch(/credentials/);
  });
});
