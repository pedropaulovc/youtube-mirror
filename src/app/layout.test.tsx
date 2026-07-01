import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RootLayout, { metadata } from "@/app/layout";

describe("RootLayout", () => {
  it("renders children", () => {
    render(<RootLayout><p>hello</p></RootLayout>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("exports metadata with title", () => {
    expect(metadata.title).toBe("TypeScript Project");
  });
});
