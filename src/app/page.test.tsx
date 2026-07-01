import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";

describe("Home", () => {
  it("renders the heading", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("TypeScript Project");
  });

  it("wraps content in a main landmark", () => {
    const { container } = render(<Home />);
    const main = container.querySelector("main");
    expect(main).toBeInTheDocument();
    if (main) expect(within(main).getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
