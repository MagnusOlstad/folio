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

async function openSeededNote(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Folio home" })).toBeVisible();
  await page.getByRole("button", { name: title, exact: true }).click();
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

async function caretLineIndex(editor: Locator) {
  return editor.evaluate((element) => {
    const selection = element.ownerDocument.getSelection();
    const anchor = selection?.anchorNode;
    const lines = Array.from(element.querySelectorAll(".cm-line"));
    return lines.findIndex(
      (line) =>
        line === anchor ||
        (anchor
          ? (line as { contains(node: unknown): boolean }).contains(anchor)
          : false),
    );
  });
}

function isContentSave(request: { method(): string; url(): string; postData(): string | null }) {
  return request.method() === "PATCH" &&
    new URL(request.url()).pathname === "/api/note" &&
    Boolean(request.postData()?.includes('"content"'));
}

test("activating a rendered line keeps one editor mounted and preserves layout", async ({ page }) => {
  await openSeededNote(page, "Todo List");

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
  await openSeededNote(page, "Todo List");

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

test("ArrowUp enters a heading line instead of skipping it", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const surface = liveSurface(page);
  await editor.fill("Above\n# Heading\nBelow");

  await editor.press("ArrowUp");

  await expect.poll(() => visibleSurfaceText(surface)).toBe(
    "Above\n# Heading\nBelow",
  );
});

test("renders heading levels and GFM strikethrough distinctly", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const surface = liveSurface(page);
  await editor.fill("# First\n## Second\n### Third\n~~Removed~~");

  await expect(surface.locator(".cm-live-markdown-heading-1")).toHaveCSS(
    "font-size",
    "30px",
  );
  await expect(surface.locator(".cm-live-markdown-heading-2")).toHaveCSS(
    "font-size",
    "26px",
  );
  await expect(surface.locator(".cm-live-markdown-heading-3")).toHaveCSS(
    "font-size",
    "22px",
  );
  await expect(surface.locator(".cm-live-markdown-strike")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
});

test("renders one clickable control for a task-list marker", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  await editor.fill("- [ ] Task\nBelow");

  const task = page.getByRole("checkbox", {
    name: "Toggle task on line 1",
  });
  const taskLine = editor.locator(".cm-line").first();
  await expect(task).toBeVisible();
  await expect(taskLine).not.toContainText("•");

  await task.click();

  await expect(task).toBeChecked();
});

test("keeps the caret on a newly inserted line", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  await editor.fill("# First\nSecond");
  await editor.press("ArrowUp");
  await editor.press("End");

  await editor.press("Enter");
  await editor.type("Middle");

  await expect.poll(() => visibleSurfaceText(liveSurface(page))).toBe(
    "First\nMiddle\nSecond",
  );
});

test("keeps the caret after two newlines at the end of a note", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  await editor.fill("# First");

  await editor.press("Enter");
  await editor.press("Enter");

  await expect(editor.locator(".cm-line")).toHaveCount(3);
  await expect.poll(() => caretLineIndex(editor)).toBe(2);

  await editor.type("Tail");
  await expect(editor.locator(".cm-line").nth(2)).toHaveText("Tail");
});

test("keeps the caret after two newlines at the end of a filed note", async ({ page }) => {
  await openSeededNote(page, "Set Up Ollama");
  const editor = liveEditor(page, "Set Up Ollama");
  const lines = editor.locator(".cm-line");
  const save = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === "/api/note",
  );
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );

  await editor.press("Enter");
  await editor.press("Enter");
  await save;

  const lineCount = await lines.count();
  await expect.poll(() => caretLineIndex(editor)).toBe(lineCount - 1);
  await editor.type("Tail");
  await expect(lines.last()).toHaveText("Tail");
});

test("continues a loose bullet list without adding another blank line", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("New note (Cmd+T)").click();
  const editor = page.getByLabel("Write a new note");
  const lines = editor.locator(".cm-line");
  await editor.fill("- first\n\n- later");
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
  );
  await editor.press("End");

  await editor.press("Enter");
  await editor.type("second");

  await expect(lines).toHaveCount(4);
  await expect(lines.nth(0)).toContainText("first");
  await expect(lines.nth(1)).toContainText("second");
  await expect(lines.nth(2)).toHaveText("");
  await expect(lines.nth(3)).toContainText("later");
});

test("autosaves quickly and reembeds on blur and Cmd/Ctrl+S", async ({ page }) => {
  await openSeededNote(page, "Daily 2026-09-03");

  const editor = liveEditor(page, "Daily 2026-09-03");
  await page
    .locator("[data-live-markdown-editor]")
    .getByRole("heading", { name: "Daily 2026-09-03", level: 1 })
    .click();
  await editor.press("End");

  const idleMarker = " e2e-idle-save";
  let sawIdleSave = false;
  const idleSave = page.waitForRequest(isContentSave).then((request) => {
    sawIdleSave = true;
    return request;
  });
  await editor.type(idleMarker);
  await page.waitForTimeout(250);
  expect(sawIdleSave, "content should not save before the 500 ms idle debounce").toBeFalsy();
  expect((await idleSave).postDataJSON()).toMatchObject({
    refreshEmbeddings: false,
  });

  const blurMarker = " e2e-blur-save";
  const blurSave = page.waitForRequest((request) =>
    isContentSave(request) && Boolean(request.postData()?.includes(blurMarker)),
  );
  const blurEmbedding = page.waitForRequest((request) => {
    if (request.method() !== "PATCH") return false;
    if (new URL(request.url()).pathname !== "/api/note") return false;
    const body = request.postDataJSON();
    return body.refreshEmbeddings === true && !("content" in body);
  });
  await editor.type(blurMarker);
  await page.getByRole("link", { name: "Folio home" }).focus();
  expect((await blurSave).postDataJSON()).toMatchObject({
    refreshEmbeddings: false,
  });
  await blurEmbedding;

  await editor.focus();
  const shortcutMarker = " e2e-shortcut-save";
  const shortcutSave = page.waitForRequest((request) =>
    isContentSave(request) && Boolean(request.postData()?.includes(shortcutMarker)),
  );
  const shortcutEmbedding = page.waitForRequest((request) => {
    if (request.method() !== "PATCH") return false;
    if (new URL(request.url()).pathname !== "/api/note") return false;
    const body = request.postDataJSON();
    return body.refreshEmbeddings === true && !("content" in body);
  });
  await editor.type(shortcutMarker);
  await page.keyboard.press(`${modifier}+s`);
  expect((await shortcutSave).postDataJSON()).toMatchObject({
    refreshEmbeddings: false,
  });
  await shortcutEmbedding;
});

test("flushes and reembeds a filed note when its tab closes", async ({ page }) => {
  await openSeededNote(
    page,
    "Capture and Organize Notes",
  );

  const editor = liveEditor(page, "Capture and Organize Notes");
  await editor.press(
    process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
  );

  const marker = " e2e-close-save";
  const contentSave = page.waitForRequest((request) =>
    isContentSave(request) && Boolean(request.postData()?.includes(marker)),
  );
  const embeddingRefresh = page.waitForRequest((request) => {
    if (request.method() !== "PATCH") return false;
    if (new URL(request.url()).pathname !== "/api/note") return false;
    const body = request.postDataJSON();
    return body.refreshEmbeddings === true && !("content" in body);
  });

  await editor.type(marker);
  await page
    .getByRole("button", {
      name: "Close Capture and Organize Notes",
      exact: true,
    })
    .click();

  expect((await contentSave).postDataJSON()).toMatchObject({
    refreshEmbeddings: false,
  });
  await embeddingRefresh;
});

test("keeps the outer document scroll stable when a rendered construct is activated", async ({ page }) => {
  await openSeededNote(page, "Start Here");

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
  await openSeededNote(page, "Start Here");

  const scroller = scrollSurface(page);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  const startHereScroll = await scroller.evaluate((element) => element.scrollTop);
  expect(startHereScroll).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Todo List", exact: true }).click();
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
