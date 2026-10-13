import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "./ThemeProvider";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_KEY } from "@/lib/theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => window.localStorage.clear());

function setup() {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("switches to dark, sets the class on <html> and remembers the choice", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Theme" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /dark/i }));
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("switches back to light", async () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    document.documentElement.classList.add("dark");
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Theme" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /light/i }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("still works when storage is blocked", async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      setup();
      await userEvent.click(screen.getByRole("button", { name: "Theme" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /dark/i }));
      expect(document.documentElement).toHaveClass("dark");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
