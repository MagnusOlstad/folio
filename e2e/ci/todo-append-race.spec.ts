import { expect, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("Todo append survives a held stale autosave and Enter filing acceptance", async ({ page, request }) => {
  const todoUrl = "/api/note?id=%2Ftodo-list.md";
  const initialResponse = await request.get(todoUrl);
  expect(initialResponse.ok()).toBeTruthy();
  const initial = await initialResponse.json() as { content: string };

  let releaseStaleSave: (() => void) | undefined;
  const holdStaleSave = new Promise<void>((resolve) => { releaseStaleSave = resolve; });
  let resolveIntercepted: ((body: Record<string, unknown>) => void) | undefined;
  const interceptedSave = new Promise<Record<string, unknown>>((resolve) => { resolveIntercepted = resolve; });
  await page.route("**/api/note*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.searchParams.get("id") === "/todo-list.md") {
      const body = request.postDataJSON() as Record<string, unknown>;
      resolveIntercepted?.(body);
      await holdStaleSave;
    }
    await route.continue();
  });

  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Todo List", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Todo List", exact: true }).click();
    const todoEditor = page.getByRole("textbox", { name: "Edit Todo List" });
    await expect(todoEditor).toBeVisible();
    await todoEditor.fill(`${initial.content}\n- [ ] Keep my local Todo edit`);
    const staleBody = await interceptedSave;
    expect(staleBody.baseContent).toBe(initial.content);

    await page.keyboard.press(`${modifier}+t`);
    const draft = page.getByRole("textbox", { name: "Write a new note" });
    await expect(draft).toBeVisible();
    await draft.fill("Todo\nBook dentist\nCall Sam about Friday");
    await page.keyboard.press(`${modifier}+s`);

    const confirmation = page.getByRole("dialog", { name: "Filing confirmation" });
    await expect(confirmation).toContainText("Append to destination");
    await page.keyboard.press("Enter");
    await expect(confirmation).toHaveCount(0);
    await expect.poll(() => todoEditor.innerText()).toContain("Book dentist");
    await expect.poll(() => todoEditor.innerText()).toContain("Call Sam about Friday");
    await expect.poll(() => todoEditor.innerText()).toContain("Keep my local Todo edit");

    const staleResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && new URL(response.url()).searchParams.get("id") === "/todo-list.md",
    );
    releaseStaleSave?.();
    expect((await staleResponse).ok()).toBeTruthy();

    const finalResponse = await request.get(todoUrl);
    const finalNote = await finalResponse.json() as { content: string };
    expect(finalResponse.ok()).toBeTruthy();
    expect(finalNote.content).toContain("Book dentist");
    expect(finalNote.content).toContain("Call Sam about Friday");
    expect(finalNote.content).toContain("Keep my local Todo edit");

    const restoreResponse = await request.patch(todoUrl, {
      data: {
        content: initial.content,
        baseContent: finalNote.content,
        refreshEmbeddings: false,
      },
    });
    expect(restoreResponse.ok()).toBeTruthy();
  } finally {
    releaseStaleSave?.();
    await page.unroute("**/api/note*");
  }
});
