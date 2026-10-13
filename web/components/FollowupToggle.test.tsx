import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { FollowupToggle } from "./FollowupToggle";
import { resetApiState } from "@/lib/api";

const contact = { id: "c-1", email: "jo@acme.com", followupRequested: false, followupDelayDays: 7 };

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("FollowupToggle", () => {
  it("ticking calls PUT /api/contacts/:id/followup with the delay", async () => {
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: true }, followup: null }));
    const onChange = vi.fn();
    render(<FollowupToggle contact={contact} onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /follow up with jo@acme.com/i }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/api/contacts/c-1/followup", method: "PUT" });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, delayDays: 7 });
    expect(seen[0]!.headers.get("X-CSRF-Token")).toBe("t");
  });

  it("ticks immediately while the save is in flight", async () => {
    let release!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => (release = r)));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    const box = screen.getByRole("checkbox");
    await userEvent.click(box);
    expect(box).toBeChecked();
    release(json({ contact: { ...contact, followupRequested: true }, followup: null }));
    await vi.waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked();
  });

  it("unticking sends enabled:false", async () => {
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: false }, followup: null }));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox"));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: false, delayDays: 7 });
  });

  it("changing the delay of an enabled follow-up saves the new delay", async () => {
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: true, followupDelayDays: 3 }, followup: null }));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    const delay = screen.getByLabelText(/days after/i);
    await userEvent.clear(delay);
    await userEvent.type(delay, "3");
    await userEvent.tab();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, delayDays: 3 });
  });

  it("rejects an out-of-range delay without calling the server", async () => {
    const seen = stubFetch(() => json({}));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    const delay = screen.getByLabelText(/days after/i);
    await userEvent.clear(delay);
    await userEvent.type(delay, "90");
    await userEvent.tab();
    expect(await screen.findByText(/1.60 days/i)).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it("shows why the server refused and leaves the box unticked", async () => {
    stubFetch(() => json({ error: "Some contacts cannot be scheduled", refused: [{ contactId: "c-1", email: "jo@acme.com", reason: "opted_out" }] }, 409));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    const box = screen.getByRole("checkbox");
    await userEvent.click(box);
    expect(await screen.findByText(/opted out/i)).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });
});
