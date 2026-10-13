import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { ResumesPanel } from "./ResumesPanel";
import { resetApiState } from "@/lib/api";
import type { Resume } from "@/lib/types";

const resume = (over: Partial<Resume> = {}): Resume => ({
  id: "r-1",
  displayName: "General SWE",
  fileName: "Harsh - General.pdf",
  sizeBytes: 2048,
  sha256: "ab",
  isDefault: true,
  createdAt: "2030-01-01T00:00:00Z",
  usage: { pendingMessages: 0, batches: 0, contacts: 0 },
  ...over,
});
const pdf = (name = "cv.pdf", body: BlobPart = "%PDF-1.4 ok") => new File([body], name, { type: "application/pdf" });

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("ResumesPanel", () => {
  it("lists name, file name, size, default badge and usage (text only)", async () => {
    stubFetch(() =>
      json({ resumes: [resume(), resume({ id: "r-2", displayName: "Backend", fileName: "b.pdf", isDefault: false, usage: { pendingMessages: 3, batches: 1, contacts: 2 } })] }),
    );
    render(<ResumesPanel />);
    const first = (await screen.findByText("General SWE")).closest("li")!;
    expect(within(first).getByText("Default")).toBeInTheDocument();
    expect(within(first).getByText(/Harsh - General\.pdf/)).toBeInTheDocument();
    expect(within(first).getByText(/2\.0 KB/)).toBeInTheDocument();
    const second = screen.getByText("Backend").closest("li")!;
    expect(within(second).queryByText("Default")).toBeNull();
    expect(within(second).getByText(/3 scheduled emails/)).toBeInTheDocument();
    expect(within(second).getByText(/1 batch/)).toBeInTheDocument();
    expect(within(second).getByText(/2 contacts/)).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    stubFetch(() => json({ resumes: [] }));
    render(<ResumesPanel />);
    expect(await screen.findByText(/no resumes yet/i)).toBeInTheDocument();
  });

  it("checks the file and name before any request is made", async () => {
    const seen = stubFetch(() => json({ resumes: [] }));
    render(<ResumesPanel />);
    await screen.findByText(/no resumes yet/i);
    const input = screen.getByLabelText(/resume file/i);
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByText(/choose a pdf/i)).toBeInTheDocument();
    await userEvent.upload(input, new File(["hello"], "notes.txt", { type: "text/plain" }), { applyAccept: false });
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByText(/must be a pdf/i)).toBeInTheDocument();
    await userEvent.upload(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/5 MB/);
    await userEvent.upload(input, new File(["not really a pdf"], "fake.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByText(/does not look like a pdf/i)).toBeInTheDocument();
    await userEvent.upload(input, pdf());
    await userEvent.clear(screen.getByLabelText(/display name/i));
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(seen.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("uploads multipart (file + displayName), suggests a name from the file, shows progress, then reloads the list", async () => {
    let listed = 0;
    let release!: (r: Response) => void;
    const seen = stubFetch((c) => {
      if (c.method === "POST") return new Promise<Response>((r) => (release = r));
      listed++;
      return json({ resumes: listed > 1 ? [resume({ displayName: "cv" })] : [] });
    });
    render(<ResumesPanel />);
    await screen.findByText(/no resumes yet/i);
    await userEvent.upload(screen.getByLabelText(/resume file/i), pdf("cv.pdf"));
    expect(screen.getByLabelText(/display name/i)).toHaveValue("cv");
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByRole("button", { name: /uploading/i })).toBeDisabled();
    const post = seen.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/resumes");
    expect(post.body).toBeInstanceOf(FormData);
    const form = post.body as FormData;
    expect(form.get("displayName")).toBe("cv");
    expect((form.get("file") as File).name).toBe("cv.pdf");
    expect(post.headers.get("X-CSRF-Token")).toBe("t");
    release(json({ resume: resume({ displayName: "cv" }) }, 201));
    expect(await screen.findByText("cv")).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toHaveValue("");
  });

  it("shows the server's refusal (duplicate name) next to the form", async () => {
    stubFetch((c) => (c.method === "POST" ? json({ error: "A resume with this name already exists" }, 409) : json({ resumes: [] })));
    render(<ResumesPanel />);
    await screen.findByText(/no resumes yet/i);
    await userEvent.upload(screen.getByLabelText(/resume file/i), pdf());
    await userEvent.click(screen.getByRole("button", { name: /upload resume/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A resume with this name already exists");
  });

  it("renames and sets the default", async () => {
    const seen = stubFetch((c) => (c.method === "PUT" ? json({ resume: resume() }) : json({ resumes: [resume({ isDefault: false })] })));
    render(<ResumesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /make general swe the default/i }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(String(seen.find((c) => c.method === "PUT")!.body))).toEqual({ isDefault: true });
    expect(seen.find((c) => c.method === "PUT")!.url).toBe("/api/resumes/r-1");
    await userEvent.click(await screen.findByRole("button", { name: /rename general swe/i }));
    const field = screen.getByLabelText(/new name for general swe/i);
    await userEvent.clear(field);
    await userEvent.type(field, "Backend v2");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    await vi.waitFor(() => expect(seen.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(JSON.parse(String(seen.filter((c) => c.method === "PUT")[1]!.body))).toEqual({ displayName: "Backend v2" });
  });

  it("asks before deleting, then deletes", async () => {
    const seen = stubFetch((c) => (c.method === "DELETE" ? json({ ok: true }) : json({ resumes: [resume()] })));
    render(<ResumesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /delete general swe/i }));
    expect(screen.getByText(/delete this resume\?/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete resume" }));
    await vi.waitFor(() => expect(seen.find((c) => c.method === "DELETE")?.url).toBe("/api/resumes/r-1"));
  });

  it("explains a 409 delete refusal with the count and keeps the resume", async () => {
    stubFetch((c) =>
      c.method === "DELETE"
        ? json({ error: "This resume is attached to 3 messages that have not been sent yet. Cancel or send them first.", pendingMessages: 3 }, 409)
        : json({ resumes: [resume()] }),
    );
    render(<ResumesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /delete general swe/i }));
    await userEvent.click(screen.getByRole("button", { name: "Delete resume" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/3 emails/i);
    expect(alert).toHaveTextContent(/not been sent yet/i);
    expect(screen.getByText("General SWE")).toBeInTheDocument();
  });
});
