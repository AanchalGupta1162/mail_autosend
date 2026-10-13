import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { SendWindowForm } from "./SendWindowForm";
import { resetApiState } from "@/lib/api";

const W = { start: "09:00", end: "10:00", tz: "Asia/Kolkata" };

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("SendWindowForm", () => {
  it("loads the window and says whether it is enforced", async () => {
    stubFetch(() => json({ enforced: true, window: W }));
    render(<SendWindowForm />);
    expect(await screen.findByLabelText("Start")).toHaveValue("09:00");
    expect(screen.getByLabelText("End")).toHaveValue("10:00");
    expect(screen.getByLabelText("Time zone")).toHaveValue("Asia/Kolkata");
    expect(screen.getByText(/real emails are only sent inside this window/i)).toBeInTheDocument();
  });

  it("explains that the window is not enforced locally", async () => {
    stubFetch(() => json({ enforced: false, window: W }));
    render(<SendWindowForm />);
    await screen.findByLabelText("Start");
    expect(screen.getByText(/not enforced on this server/i)).toBeInTheDocument();
  });

  it("blocks an invalid window without calling the server", async () => {
    const seen = stubFetch(() => json({ enforced: true, window: W }));
    render(<SendWindowForm />);
    const end = await screen.findByLabelText("End");
    await userEvent.clear(end);
    await userEvent.type(end, "08:00");
    await userEvent.click(screen.getByRole("button", { name: /save window/i }));
    expect(await screen.findByText(/end must be after start/i)).toBeInTheDocument();
    expect(seen.filter((s) => s.method === "PUT")).toHaveLength(0);
  });

  it("saves a valid window with a PUT and confirms", async () => {
    const seen = stubFetch((c) => (c.method === "PUT" ? json({ enforced: true, window: JSON.parse(String(c.body)) }) : json({ enforced: true, window: W })));
    render(<SendWindowForm />);
    const start = await screen.findByLabelText("Start");
    await userEvent.clear(start);
    await userEvent.type(start, "08:30");
    await userEvent.click(screen.getByRole("button", { name: /save window/i }));
    expect(await screen.findByText(/window saved/i)).toBeInTheDocument();
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.url).toBe("/api/settings/send-window");
    expect(JSON.parse(String(put.body))).toEqual({ start: "08:30", end: "10:00", tz: "Asia/Kolkata" });
  });

  it("shows the server's refusal", async () => {
    stubFetch((c) => (c.method === "PUT" ? json({ error: "Invalid send window: tz must be an IANA time zone, e.g. Asia/Kolkata" }, 400) : json({ enforced: true, window: W })));
    render(<SendWindowForm />);
    await screen.findByLabelText("Start");
    await userEvent.click(screen.getByRole("button", { name: /save window/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/IANA time zone/);
  });
});
