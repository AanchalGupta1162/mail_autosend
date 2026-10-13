import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { json, stubFetch } from "@/test/fetch";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import { AppShell } from "./AppShell";
import { resetApiState } from "@/lib/api";

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("AppShell mode indicator", () => {
  it("shows the dry-run banner and chip when the server is in dry run", async () => {
    stubFetch(() => json({ dryRun: true, followupsHeld: false }));
    render(<AppShell>page</AppShell>);
    expect(await screen.findByText(/never delivered/i)).toBeInTheDocument();
    expect(screen.getByText("Dry run", { selector: ".mode-chip" })).toBeInTheDocument();
  });

  it("says the mode is unknown when the dashboard cannot be loaded, instead of showing nothing", async () => {
    stubFetch(() => json({ error: "Internal server error" }, 500));
    render(<AppShell>page</AppShell>);
    expect(await screen.findByText(/mode unknown/i)).toBeInTheDocument();
    expect(screen.queryByText("Live sending")).toBeNull();
  });
});
