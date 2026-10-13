import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { ContactsView } from "./ContactsView";
import { resetApiState } from "@/lib/api";
import type { ContactListItem } from "@/lib/types";

const row: ContactListItem = {
  id: "c-1",
  batchId: "b-1",
  company: "Acme",
  role: "SWE",
  person: "Jo Smith",
  email: "jo@acme.com",
  subject: "s",
  mailText: "m",
  followupText: null,
  status: "scheduled",
  followupRequested: false,
  followupDelayDays: 7,
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  messages: [{ id: "m-1", kind: "initial", state: "scheduled", scheduledFor: "2030-02-01T09:00:00Z", sentAt: null }],
};

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("ContactsView", () => {
  it("filters by the batch from the URL and cancels a scheduled send by message id", async () => {
    let releaseReload = false;
    const seen = stubFetch((c) => {
      if (c.url === "/api/batches") return json({ batches: [] });
      if (c.method === "DELETE") {
        releaseReload = true;
        return json({ message: {}, contact: {} });
      }
      // the reload after cancel never resolves: the button must already be gone
      if (releaseReload) return new Promise<Response>(() => {});
      return json({ contacts: [row], total: 1, page: 1, pageSize: 25 });
    });
    render(<ContactsView initialBatchId="b-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel send" }));
    await vi.waitFor(() => expect(seen.some((c) => c.method === "DELETE")).toBe(true));
    expect(seen.find((c) => c.url.startsWith("/api/contacts"))!.url).toBe("/api/contacts?batchId=b-1&page=1&pageSize=25");
    expect(seen.find((c) => c.method === "DELETE")!.url).toBe("/api/messages/m-1");
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Cancel send" })).toBeNull());
  });

  it("asks before opting out, then calls the opt-out endpoint", async () => {
    const seen = stubFetch((c) => (c.url === "/api/batches" ? json({ batches: [] }) : c.method === "POST" ? json({ contact: row }) : json({ contacts: [row], total: 1, page: 1, pageSize: 25 })));
    render(<ContactsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Opt out" }));
    expect(screen.getByText(/stop all sends\?/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Opt out" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "POST")?.url).toBe("/api/contacts/c-1/opt-out"));
  });
});
