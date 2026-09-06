import { describe, expect, it } from "vitest";

import {
  conceptUrl,
  directoryForId,
  normalizeDirectoryInput,
  resolveBundleLink,
} from "../../src/lib/paths.ts";

describe("workspace path behavior", () => {
  it("builds concept requests with an encoded path", () => {
    expect(conceptUrl("/projects/road map.md")).toBe(
      "/api/concepts?path=%2Fprojects%2Froad%20map.md",
    );
  });

  it("resolves markdown links relative to the current document", () => {
    expect(
      resolveBundleLink(
        "/guides/start-here.md",
        "../daily/today.md?view=reader#top",
      ),
    ).toBe("/daily/today.md");
    expect(
      resolveBundleLink("/guides/start-here.md", "/projects/roadmap.md"),
    ).toBe("/projects/roadmap.md");
    expect(resolveBundleLink("/guides/start-here.md", "notes%20one.md")).toBe(
      "/guides/notes one.md",
    );
  });

  it("does not treat anchors, external URLs, invalid encodings, or non-markdown files as bundle links", () => {
    expect(resolveBundleLink("/guides/start-here.md", "#section")).toBeNull();
    expect(
      resolveBundleLink("/guides/start-here.md", "https://example.com/note.md"),
    ).toBeNull();
    expect(
      resolveBundleLink("/guides/start-here.md", "%E0%A4%A.md"),
    ).toBeNull();
    expect(resolveBundleLink("/guides/start-here.md", "image.png")).toBeNull();
  });

  it("normalizes directory input and identifies parent directories", () => {
    expect(normalizeDirectoryInput("  projects\\roadmap//2026  ")).toBe(
      "/projects/roadmap/2026",
    );
    expect(normalizeDirectoryInput(" / ")).toBe("/");
    expect(directoryForId("/projects/roadmap.md")).toBe("/projects");
    expect(directoryForId("/index.md")).toBe("/");
  });
});
