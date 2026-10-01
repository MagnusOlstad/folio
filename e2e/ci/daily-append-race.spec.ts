import { expect, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("Daily Note append preserves stale editor changes and ordinary paragraphs", async ({ page, request }) => {
  const created = await request.post("/api/notes", {
    data: { content: "daily: Morning reflection.\nFirst paragraph.", timeZone: "UTC" },
  });
  expect(created.ok()).toBeTruthy();
  const initialNote = await created.json() as { note: { id: string; title: string } };
  const initialDocumentResponse = await request.get(`/api/note?id=${encodeURIComponent(initialNote.note.id)}`);
  expect(initialDocumentResponse.ok()).toBeTruthy();
  const initialDocument = await initialDocumentResponse.json() as { content: string };
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Todo List", exact: true })).toBeVisible();

  let releaseStaleSave: (() => void) | undefined;
  const holdStaleSave = new Promise<void>((resolve) => { releaseStaleSave = resolve; });
  let resolveStaleRequest: ((body: Record<string, unknown>) => void) | undefined;
  const staleRequest = new Promise<Record<string, unknown>>((resolve) => { resolveStaleRequest = resolve; });
  let resolveFilingPost: (() => void) | undefined;
  const filingPost = new Promise<void>((resolve) => { resolveFilingPost = resolve; });
  await page.route("**/api/note*", async (route) => {
    const currentRequest = route.request();
    const url = new URL(currentRequest.url());
    if (currentRequest.method() === "POST" && url.pathname.endsWith("/api/notes")) resolveFilingPost?.();
    if (currentRequest.method() === "PATCH" && url.searchParams.get("id") === initialNote.note.id) {
      resolveStaleRequest?.(currentRequest.postDataJSON() as Record<string, unknown>);
      await holdStaleSave;
    }
    await route.continue();
  });
  try {
    const dailyDirectory = page.locator("button.tree-directory").filter({ hasText: /daily/i });
    await expect(dailyDirectory).toBeVisible();
    if (await dailyDirectory.getAttribute("aria-expanded") !== "true") await dailyDirectory.click();
    const dailyFile = page.locator("button.tree-file[aria-label]").filter({ hasText: initialNote.note.title });
    await expect(dailyFile).toBeVisible();
    await dailyFile.click();
    const dailyEditor = page.getByRole("textbox", { name: `Edit ${initialNote.note.title}` });
    await expect(dailyEditor).toBeVisible();
    await dailyEditor.fill(`${initialDocument.content}\n\nA local paragraph saved before the next capture.`);
    const staleBody = await staleRequest;
    expect(staleBody.baseContent).toBe(initialDocument.content);

    await page.keyboard.press(`${modifier}+t`);
    const draft = page.getByRole("textbox", { name: "Write a new note" });
    await expect(draft).toBeVisible();
    await draft.fill("Daily\nEvening reflection.\nSend the report.");
    await page.keyboard.press(`${modifier}+s`);
    const confirmation = page.getByRole("dialog", { name: "Filing confirmation" });
    await expect(confirmation).toHaveCount(0);
    expect(await Promise.race([filingPost.then(() => true), page.waitForTimeout(50).then(() => false)])).toBe(false);
    await draft.fill("Daily\nEvening reflection.\nSend the report.\nCall the team tomorrow.");

    const staleResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && new URL(response.url()).searchParams.get("id") === initialNote.note.id,
    );
    releaseStaleSave?.();
    expect((await staleResponse).ok()).toBeTruthy();
    await filingPost;
    await expect(confirmation).toContainText("Append to destination");
    await page.keyboard.press("Enter");
    await expect(confirmation).toHaveCount(0);
    await expect.poll(() => dailyEditor.innerText()).toContain("A local paragraph saved before the next capture.");
    await expect.poll(() => dailyEditor.innerText()).toContain("Evening reflection.");
    await expect.poll(() => dailyEditor.innerText()).toContain("Call the team tomorrow.");

    const finalResponse = await request.get(`/api/note?id=${encodeURIComponent(initialNote.note.id)}`);
    expect(finalResponse.ok()).toBeTruthy();
    const finalNote = await finalResponse.json() as { content: string; type: string };
    expect(finalNote.type).toBe("Daily Note");
    expect(finalNote.content).toContain("A local paragraph saved before the next capture.");
    expect(finalNote.content).toContain("Evening reflection.");
    expect(finalNote.content).toContain("Call the team tomorrow.");
    expect(finalNote.content).not.toMatch(/- \[[ x]\]/);
    await page.screenshot({ path: "test-results/daily-append-race.png", fullPage: true });
  } finally {
    releaseStaleSave?.();
    await page.unrouteAll();
  }
});
