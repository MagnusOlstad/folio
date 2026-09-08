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
  return page.locator("[data-document-scroll]");
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

async function textX(locator: Locator, text: string) {
  return locator.evaluate((element, target) => {
    const ownerDocument = element.ownerDocument;
    const walker = ownerDocument.createTreeWalker(element, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent?.indexOf(target) ?? -1;
      if (offset === -1) continue;
      const range = ownerDocument.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + target.length);
      return range.getBoundingClientRect().x;
    }
    throw new Error(`Could not find ${target}`);
  }, text);
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

test("keeps the outer document scroll stable when a rendered construct is activated", async ({ page }) => {
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

test("restores each note scroll position when switching tabs", async ({ page }) => {
  await openSeededNote(page, "start-here.md", "Start Here");

  const scroller = scrollSurface(page);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  const startHereScroll = await scroller.evaluate((element) => element.scrollTop);
  expect(startHereScroll).toBeGreaterThan(0);

  await page.getByRole("button", { name: "todo-list.md" }).click();
  await expect(liveEditor(page, "Todo List")).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);

  await page.locator(".editor-tab").filter({ hasText: "Start Here" }).click();
  await expect(liveEditor(page, "Start Here")).toBeVisible();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(startHereScroll);

  await page.locator(".editor-tab").filter({ hasText: "Todo List" }).click();
  await expect(liveEditor(page, "Todo List")).toBeVisible();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
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
    "Draft heading\n•parent\n  - child",
  );
  await expect(editor).toBeFocused();

  const childLine = surface.locator(".cm-line").filter({ hasText: "child" });
  const rawChildX = await textX(childLine, "child");
  const lineBox = await childLine.boundingBox();
  const rawMarkerBox = await childLine
    .locator(".cm-live-markdown-list-source")
    .boundingBox();
  expect(rawMarkerBox!.x).toBeGreaterThan(lineBox!.x);

  await editor.press("ArrowUp");
  await expect(childLine.locator(".cm-live-markdown-list-marker-nested")).toBeVisible();
  expect(Math.abs((await textX(childLine, "child")) - rawChildX)).toBeLessThanOrEqual(1);

  await editor.press("ArrowDown");
  await editor.press("Shift+Tab");
  await expect.poll(() => visibleSurfaceText(surface)).toBe(
    "Draft heading\n•parent\n- child",
  );
});

test("draft Find stays over the editor and reports match progress", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const filler = Array.from({ length: 80 }, (_, index) => `filler ${index}`).join("\n");
  await editor.fill(`alpha beta alpha\n${filler}\nalpha`);
  const steeringBand = page.locator(".draft-steering-band");
  const scroller = scrollSurface(page);
  await scroller.evaluate((element) => {
    element.scrollTop = 500;
  });
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        const requestFrame = element.ownerDocument.defaultView?.requestAnimationFrame;
        if (!requestFrame) return resolve();
        requestFrame(() => requestFrame(() => resolve()));
      }),
  );
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);
  const before = await steeringBand.boundingBox();

  await page.keyboard.press(`${modifier}+f`);
  const find = page.getByRole("searchbox", { name: "Find in note" });
  await expect(find).toBeFocused();
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(scrollBefore);
  const afterOpen = await steeringBand.boundingBox();
  expect(afterOpen?.y).toBe(before?.y);
  expect(afterOpen?.height).toBe(before?.height);
  const noteBox = await page.locator(".document-view").boundingBox();
  const findBox = await find.locator("xpath=..").boundingBox();
  const findPanel = find.locator("xpath=../..");
  await expect
    .poll(() =>
      findPanel.evaluate(
        (element) =>
          element.ownerDocument.defaultView?.getComputedStyle(element)
            .backgroundColor,
      ),
    )
    .toBe("rgb(32, 35, 31)");
  expect(Math.abs(findBox!.y - noteBox!.y - 10)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(noteBox!.x + noteBox!.width - findBox!.x - findBox!.width - 12),
  ).toBeLessThanOrEqual(1);
  await find.fill("alpha");

  await expect(page.getByText("3 results")).toBeVisible();
  const after = await steeringBand.boundingBox();
  expect(after?.height).toBe(before?.height);

  await page.getByRole("button", { name: "Next match" }).click();
  await expect(page.getByText("1 of 3 results")).toBeVisible();
  const closeBox = await page.getByRole("button", { name: "Close Find" }).boundingBox();
  expect(closeBox?.width).toBeGreaterThanOrEqual(32);
  expect(closeBox?.height).toBeGreaterThanOrEqual(32);
});
