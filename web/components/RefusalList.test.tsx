import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RefusalList } from "./RefusalList";

describe("RefusalList", () => {
  it("lists every refused contact with a readable reason and says nothing was scheduled", () => {
    render(
      <RefusalList
        refused={[
          { contactId: "1", email: "a@x.com", reason: "replied" },
          { contactId: "2", email: "b@x.com", reason: "other_batch_opted_out" },
          { contactId: "3", email: null, reason: "not_in_batch" },
          { contactId: "4", email: "d@x.com", reason: "suppressed" },
        ]}
      />,
    );
    const region = screen.getByRole("alert");
    expect(region).toHaveTextContent(/nothing was scheduled/i);
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("a@x.com");
    expect(items[0]).toHaveTextContent(/already replied/i);
    expect(items[1]).toHaveTextContent(/opted out in another batch/i);
    expect(items[2]).toHaveTextContent(/unknown contact/i);
    expect(items[2]).toHaveTextContent(/not part of this batch/i);
    expect(items[3]).toHaveTextContent(/suppression list/i);
  });

  it("renders addresses as text, never markup", () => {
    const { container } = render(<RefusalList refused={[{ contactId: "1", email: "<img src=x onerror=alert(1)>@x.com", reason: "failed" }]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });
});
