import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { BatchScheduler } from "./BatchScheduler";
import { resetApiState } from "@/lib/api";
import { toLocalInputValue } from "@/lib/schedule";
import type { ContactWithPreview, UploadResult } from "@/lib/types";

const contact = (id: string, email: string, text = "Hi there"): ContactWithPreview => ({
  id,
  batchId: "b-1",
  company: "Acme",
  role: "SWE Intern",
  person: "Jo Smith",
  email,
  subject: `Subject ${id}`,
  mailText: text,
  followupText: null,
  status: "uploaded",
  followupRequested: false,
  followupDelayDays: 7,
  repliedAt: null,
  error: null,
  createdAt: "2030-01-01T00:00:00Z",
  preview: { subject: `Subject ${id}`, text },
});

const upload = (over: Partial<UploadResult> = {}): UploadResult => ({
  batch: { id: "b-1", name: "Leads", originalFilename: "leads.csv", createdAt: "2030-01-01T00:00:00Z" },
  contacts: [contact("c-1", "a@x.com"), contact("c-2", "b@x.com")],
  errors: [],
  warnings: [],
  ...over,
});

const tomorrow = () => toLocalInputValue(new Date(Date.now() + 24 * 3600_000));
const sendAtInput = () => screen.getByLabelText(/^send at/i);
const confirm = () => screen.getByRole("button", { name: /schedule \d+ email/i });

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("BatchScheduler", () => {
  it("keeps Confirm disabled until a valid future time is set, and explains a past time", () => {
    stubFetch(() => json({}));
    render(<BatchScheduler upload={upload()} />);
    expect(confirm()).toBeDisabled();
    fireEvent.change(sendAtInput(), { target: { value: "2020-01-01T09:00" } });
    expect(screen.getByText(/must be in the future/i)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    fireEvent.change(sendAtInput(), { target: { value: tomorrow() } });
    expect(confirm()).toBeEnabled();
  });

  it("explains a past time even before any row is selected", async () => {
    stubFetch(() => json({}));
    render(<BatchScheduler upload={upload()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /select all/i }));
    fireEvent.change(sendAtInput(), { target: { value: "2020-01-01T09:00" } });
    expect(screen.getByText(/must be in the future/i)).toBeInTheDocument();
  });

  it("disables Confirm when nothing is selected", async () => {
    stubFetch(() => json({}));
    render(<BatchScheduler upload={upload()} />);
    fireEvent.change(sendAtInput(), { target: { value: tomorrow() } });
    await userEvent.click(screen.getByRole("checkbox", { name: /select all/i }));
    expect(screen.getByRole("button", { name: /schedule 0 emails/i })).toBeDisabled();
  });

  it("schedules only the selected rows with the stagger, in table order", async () => {
    const seen = stubFetch(() => json({ messages: [] }, 201));
    render(<BatchScheduler upload={upload({ contacts: [contact("c-1", "a@x.com"), contact("c-2", "b@x.com"), contact("c-3", "c@x.com")] })} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /select b@x.com/i }));
    const at = tomorrow();
    fireEvent.change(sendAtInput(), { target: { value: at } });
    fireEvent.change(screen.getByLabelText(/stagger/i), { target: { value: "5" } });
    await userEvent.click(confirm());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ url: "/api/batches/b-1/schedule", method: "POST" });
    const [y, mo, d] = at.slice(0, 10).split("-").map(Number);
    const [h, mi] = at.slice(11).split(":").map(Number);
    expect(JSON.parse(String(seen[0]!.body))).toEqual({
      contactIds: ["c-1", "c-3"],
      sendAt: new Date(y!, mo! - 1, d!, h!, mi!).toISOString(),
      staggerMinutes: 5,
    });
  });

  it("shows the server's refusal list when the batch is refused (409) and offers to deselect them", async () => {
    stubFetch(() =>
      json({ error: "Some contacts cannot be scheduled", refused: [{ contactId: "c-2", email: "b@x.com", reason: "other_batch_replied" }] }, 409),
    );
    render(<BatchScheduler upload={upload()} />);
    fireEvent.change(sendAtInput(), { target: { value: tomorrow() } });
    await userEvent.click(confirm());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/nothing was scheduled/i);
    expect(within(alert).getByText("b@x.com")).toBeInTheDocument();
    expect(alert).toHaveTextContent(/replied in another batch/i);
    await userEvent.click(within(alert).getByRole("button", { name: /deselect/i }));
    expect(screen.getByRole("checkbox", { name: /select b@x.com/i })).not.toBeChecked();
  });

  it("lists rejected rows and cross-batch warnings from the upload", () => {
    stubFetch(() => json({}));
    render(
      <BatchScheduler
        upload={upload({
          errors: [{ row: 3, message: "Email is not a valid address" }],
          warnings: [{ row: 2, message: "Email is already in another batch (status: sent)", existingStatus: "sent" }],
        })}
      />,
    );
    expect(screen.getByText(/row 3/i).closest("li")).toHaveTextContent("Email is not a valid address");
    expect(screen.getByText(/already in another batch \(status: sent\)/i)).toBeInTheDocument();
    // the warned row starts unselected
    expect(screen.getByRole("checkbox", { name: /select a@x.com/i })).not.toBeChecked();
  });

  it("renders the email preview as plain text, never as markup", async () => {
    stubFetch(() => json({}));
    const evil = 'Hi <img src=x onerror="alert(1)"> <b>bold</b>';
    const { container } = render(<BatchScheduler upload={upload({ contacts: [contact("c-1", "a@x.com", evil)] })} />);
    await userEvent.click(screen.getByRole("button", { name: /preview email to a@x.com/i }));
    expect(screen.getByText(/onerror="alert\(1\)"/)).toBeInTheDocument();
    expect(container.querySelector("img, b")).toBeNull();
  });

  it("per-row override is validated and sent as its own call", async () => {
    const seen = stubFetch((c) => (c.url.includes("/schedule") && c.method === "PUT" ? json({ message: { id: "m" } }) : json({ messages: [] }, 201)));
    render(<BatchScheduler upload={upload()} />);
    fireEvent.change(sendAtInput(), { target: { value: tomorrow() } });
    await userEvent.click(screen.getByRole("button", { name: /set own time for b@x.com/i }));
    const own = screen.getByLabelText(/send time for b@x.com/i);
    fireEvent.change(own, { target: { value: "2020-01-01T09:00" } });
    expect(confirm()).toBeDisabled();
    const later = toLocalInputValue(new Date(Date.now() + 48 * 3600_000));
    fireEvent.change(own, { target: { value: later } });
    await userEvent.click(confirm());
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/batches/b-1/schedule", "PUT /api/contacts/c-2/schedule"]);
    expect(JSON.parse(String(seen[0]!.body)).contactIds).toEqual(["c-1"]);
  });
});
