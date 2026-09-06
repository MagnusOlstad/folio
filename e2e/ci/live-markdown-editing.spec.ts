import { expect, test, type Locator, type Page } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
type E2eElement = { __e2eIdentity?: string; innerText?: string };

function liveEditor(page: Page, title: string) {
  return page.getByRole("textbox", { name: `Edit ${title}` });
}

function liveSurface(page: Page) {
  return page.locator("[data-live-markdown-editor]");
}

function scrollSurface(page: Page) {
  return page.locator("[data-live-markdown-scroll]");
}

async function openSeededNote(page: Page, filename: string, title: string) {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Folio home" })).toBeVisible();
  await page.getByRole("button", { name: filename }).click();
  await expect(liveEditor(page, title)).toBeVisible();
}

async function stableY(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "expected the comparison line to be visible").not.toBeNull();
  return box!.y;
}

async function visibleSurfaceText(surface: Locator) {
  return surface.evaluate(
    (element) => (element as unknown as E2eElement).innerText ?? "",
  );
}

function isContentSave(request: { method(): string; url(): string; postData(): string | null }) {
  return request.method() === "PATCH" &&
    new URL(request.url()).pathname === "/api/note" &&
    Boolean(request.postData()?.includes('"content"'));
}

test("activating a rendered line keeps one editor mounted and preserves layout", async ({ page }) => {
  await openSeededNote(page, "todo-list.md", "Todo List");

  const surface = liveSurface(page);
  const editor = liveEditor(page, "Todo List");
  const followingLine = page.getByText("Add your first task", { exact: false });
  const marker = await surface.evaluate((element) => {
    const identity = `live-editor-${Math.random()}`;
    (element as unknown as E2eElement).__e2eIdentity = identity;
    return identity;
  });
  const yBefore = await stableY(followingLine);

  await surface.getByRole("heading", { name: "Todo List", level: 1 }).click();

  await expect(editor).toBeFocused();
  await expect.poll(() => visibleSurfaceText(surface)).toMatch(/# Todo List/);
  expect(await surface.evaluate((element) =>
    (element as unknown as E2eElement).__e2eIdentity,
  )).toBe(marker);
  expect(Math.abs((await stableY(followingLine)) - yBefore)).toBeLessThanOrEqual(1);
});

test("moving off a line restores its Markdown presentation and reveals the next line", async ({ page }) => {
  await openSeededNote(page, "todo-list.md", "Todo List");

  const surface = liveSurface(page);
  const editor = liveEditor(page, "Todo List");
  await surface.getByRole("heading", { name: "Todo List", level: 1 }).click();
  await editor.press("End");
  await editor.press("Enter");

  await expect(
    surface.getByRole("heading", { name: "Todo List", level: 1 }),
  ).toBeVisible();
  await expect.poll(() => visibleSurfaceText(surface)).not.toMatch(/# Todo List/);

  await surface.getByText("Add your first task", { exact: false }).click();
  await expect.poll(() => visibleSurfaceText(surface)).toMatch(/- \[ \] Add your first task/);

  // Keep the shared seeded document unchanged even if an implementation saves very
  // aggressively; cursor moves themselves do not need to be persisted.
  await page.keyboard.press(`${modifier}+z`);
});

test("autosaves after an idle edit and flushes later edits on blur and Cmd/Ctrl+S", async ({ page }) => {
  await openSeededNote(page, "2026-09-03.md", "Daily 2026-09-03");

  const editor = liveEditor(page, "Daily 2026-09-03");
  await page
    .locator("[data-live-markdown-editor]")
    .getByRole("heading", { name: "Daily 2026-09-03", level: 1 })
    .click();
  await editor.press("End");

  const idleMarker = " e2e-idle-save";
  let sawIdleSave = false;
  const idleSave = page.waitForRequest(isContentSave).then(() => {
    sawIdleSave = true;
  });
  await editor.type(idleMarker);
  await page.waitForTimeout(250);
  expect(sawIdleSave, "content should not save before the 500 ms idle debounce").toBeFalsy();
  await idleSave;

  const blurMarker = " e2e-blur-save";
  const blurSave = page.waitForRequest((request) =>
    isContentSave(request) && Boolean(request.postData()?.includes(blurMarker)),
  );
  await editor.type(blurMarker);
  await page.getByRole("link", { name: "Folio home" }).focus();
  await blurSave;

  await editor.focus();
  const shortcutMarker = " e2e-shortcut-save";
  const shortcutSave = page.waitForRequest((request) =>
    isContentSave(request) && Boolean(request.postData()?.includes(shortcutMarker)),
  );
  await editor.type(shortcutMarker);
  await page.keyboard.press(`${modifier}+s`);
  await shortcutSave;
});

test("does not change scroll position or downstream line geometry when a line becomes raw", async ({ page }) => {
  await openSeededNote(page, "start-here.md", "Start Here");

  const scroller = scrollSurface(page);
  const target = page.getByText("The desktop app stores its writable bundle", { exact: false });
  const followingLine = page.getByText("These starter guides are ordinary notes", { exact: false });
  await target.scrollIntoViewIfNeeded();
  await scroller.evaluate((element) => {
    element.scrollTop = 120;
  });
  await target.scrollIntoViewIfNeeded();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
  const yBefore = await stableY(followingLine);
  await target.click();

  await expect(liveEditor(page, "Start Here")).toBeFocused();
  expect(Math.abs((await scroller.evaluate((element) => element.scrollTop)) - scrollBefore)).toBeLessThanOrEqual(1);
  expect(Math.abs((await stableY(followingLine)) - yBefore)).toBeLessThanOrEqual(1);
});

test("draft notes use live line rendering and list-aware Tab indentation", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const surface = liveSurface(page);

  await editor.fill("# Draft heading\n- parent\n- child");
  await expect(
    surface.getByRole("heading", { name: "Draft heading", level: 1 }),
  ).toBeVisible();

  await editor.press("Tab");
  await expect.poll(() => visibleSurfaceText(surface)).toBe(
    "Draft heading\nparent\n  - child",
  );
  await expect(editor).toBeFocused();

  await editor.press("Shift+Tab");
  await expect.poll(() => visibleSurfaceText(surface)).toBe(
    "Draft heading\nparent\n- child",
  );
});
