import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster } from "./Toaster";
import { toast } from "@/lib/toast";

describe("Toaster", () => {
  it("shows a message as text, announces errors, and can be dismissed", async () => {
    render(<Toaster />);
    act(() => void toast.error("<b>Could not save</b>"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("<b>Could not save</b>");
    expect(alert.querySelector("b")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
