import { expect, test, type Request, type Response, type Route } from "@playwright/test";

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
  let resolveFilingPost: (() => void) | undefined;
  const filingPost = new Promise<void>((resolve) => { resolveFilingPost = resolve; });
  let staleResponse: Promise<Response> | undefined;
  let filingConfirmation: Promise<Response> | undefined;
  const pendingTodoWrites = new Map<Request, Promise<void>>();
  const settleTodoWrite = new WeakMap<Request, () => void>();
  const failedTodoWrites: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const isTodoPatch = request.method() === "PATCH"
      && url.pathname === "/api/note"
      && url.searchParams.get("id") === "/todo-list.md";
    const isFilingWrite = request.method() === "POST"
      && (url.pathname === "/api/notes" || url.pathname === "/api/filing/confirm");
    if (!isTodoPatch && !isFilingWrite) return;
    const settled = new Promise<void>((resolve) => {
      settleTodoWrite.set(request, resolve);
    });
    pendingTodoWrites.set(request, settled);
  });
  const settleRequest = (request: Request, failed = false) => {
    if (!pendingTodoWrites.has(request)) return;
    if (failed) {
      failedTodoWrites.push(
        `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "request failed"}`,
      );
    }
    settleTodoWrite.get(request)?.();
    settleTodoWrite.delete(request);
    pendingTodoWrites.delete(request);
  };
  page.on("requestfinished", settleRequest);
  page.on("requestfailed", (request) => settleRequest(request, true));
  const noteRoute = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.searchParams.get("id") === "/todo-list.md") {
      const body = request.postDataJSON() as Record<string, unknown>;
      resolveIntercepted?.(body);
      await holdStaleSave;
    }
    await route.continue();
  };
  const notesRoute = async (route: Route) => {
    if (route.request().method() === "POST") resolveFilingPost?.();
    await route.continue();
  };
  const drainTodoWrites = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (pendingTodoWrites.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("Timed out waiting for Todo writes to settle.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...pendingTodoWrites.values()]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Timed out waiting for Todo writes to settle.")),
              remainingMs,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };
  await page.route("**/api/note*", noteRoute);
  await page.route("**/api/notes", notesRoute);

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
    await expect(confirmation).toHaveCount(0);
    expect(await Promise.race([filingPost.then(() => true), page.waitForTimeout(50).then(() => false)])).toBe(false);
    await draft.fill("Todo\nBook dentist\nCall Sam about Friday\nReview the launch notes");
    staleResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH"
      && new URL(response.url()).searchParams.get("id") === "/todo-list.md",
    );
    releaseStaleSave?.();
    expect((await staleResponse).ok()).toBeTruthy();
    await filingPost;
    await expect(confirmation).toContainText("Append to destination");
    await expect(confirmation.getByRole("button", { name: "Accept" })).toBeFocused();
    filingConfirmation = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/filing/confirm",
    );
    await page.keyboard.press("Enter");
    expect((await filingConfirmation).ok()).toBeTruthy();
    await expect(confirmation).toHaveCount(0);
    await expect.poll(() => todoEditor.innerText()).toContain("Book dentist");
    await expect.poll(() => todoEditor.innerText()).toContain("Call Sam about Friday");
    await expect.poll(() => todoEditor.innerText()).toContain("Review the launch notes");
    await expect.poll(() => todoEditor.innerText()).toContain("Keep my local Todo edit");

    const finalResponse = await request.get(todoUrl);
    const finalNote = await finalResponse.json() as { content: string };
    expect(finalResponse.ok()).toBeTruthy();
    expect(finalNote.content).toContain("Book dentist");
    expect(finalNote.content).toContain("Call Sam about Friday");
    expect(finalNote.content).toContain("Review the launch notes");
    expect(finalNote.content).toContain("Keep my local Todo edit");
  } finally {
    releaseStaleSave?.();
    await page.unroute("**/api/note*", noteRoute);
    await page.unroute("**/api/notes", notesRoute);
    let drainFailure: Error | undefined;
    try {
      await drainTodoWrites(10_000);
    } catch (error) {
      drainFailure = error instanceof Error ? error : new Error("Could not drain Todo writes.");
    }
    if (!page.isClosed()) await page.close();
    if (pendingTodoWrites.size > 0) {
      try {
        await drainTodoWrites(5_000);
      } catch (error) {
        drainFailure ??= error instanceof Error ? error : new Error("Could not drain Todo writes after closing the page.");
      }
    }

    const latestResponse = await request.get(todoUrl);
    expect(latestResponse.ok()).toBeTruthy();
    const latestNote = await latestResponse.json() as { content: string };
    if (latestNote.content !== initial.content) {
      const restoreResponse = await request.patch(todoUrl, {
        data: {
          content: initial.content,
          baseContent: latestNote.content,
          refreshEmbeddings: false,
        },
      });
      expect(restoreResponse.ok()).toBeTruthy();
    }
    expect(failedTodoWrites).toEqual([]);
    expect(drainFailure, "Todo request cleanup should settle before fixture restoration").toBeUndefined();
  }
});
