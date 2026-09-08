import { expect, test, type Page } from "@playwright/test";

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Folio home" })).toBeVisible();
}

test("closing a blank new draft removes its server copy", async ({ page, request }) => {
  await openWorkspace(page);
  await page.getByTitle("New note (Cmd+T)").click();
  const close = page.getByRole("button", { name: "Close Untitled" });
  const deletion = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/draft",
  );

  await close.click();
  const response = await deletion;
  const id = new URL(response.url()).searchParams.get("id");

  await expect(close).toHaveCount(0);
  const drafts = await (await request.get("/api/drafts")).json();
  expect(drafts).not.toContainEqual(expect.objectContaining({ id }));
});

test("closing a nonempty new draft preserves its server copy", async ({ page, request }) => {
  await openWorkspace(page);
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const content = `keep after close ${Date.now()}`;
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/draft" &&
      Boolean(response.request().postData()?.includes(content)),
  );

  await editor.fill(content);
  const response = await saved;
  const id = new URL(response.url()).searchParams.get("id");
  await page.getByRole("button", { name: "Close Untitled" }).click();

  await expect(page.getByRole("button", { name: "Close Untitled" })).toHaveCount(0);
  const drafts = await (await request.get("/api/drafts")).json();
  expect(drafts).toContainEqual(expect.objectContaining({ id, content }));
});

test("Cmd/Ctrl+F searches the open read-only bundle file", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "index.md" }).click();
  await expect(page.locator("[data-readonly-markdown]")).toBeVisible();

  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  const find = page.getByLabel("Find in current note");
  await expect(find).toBeFocused();
  await find.fill("Folio");

  await expect(page.locator(".readonly-search-match.active")).toHaveText("Folio");
  await find.press("Enter");
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
});
