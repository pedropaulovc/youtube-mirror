import { expect, test } from "@playwright/test";

test.describe("Home page", () => {
  test("displays the heading", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("TypeScript Project");
  });
});
