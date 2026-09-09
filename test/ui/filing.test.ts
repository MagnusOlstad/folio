import { describe, expect, it } from "vitest";
import {
  applyStandaloneFilingTabs,
  filingEntry,
  advanceFilingQueue,
  dismissFailedPreparation,
  finishDraftFiling,
  filingOwnerGroupIds,
  rekeyFilingQueue,
} from "../../src/features/workspace/model/filing.ts";
import {
  applyDirectorySuggestion,
  bundleDirectories,
  directorySuggestionContext,
} from "../../src/features/workspace/model/directory-suggestions.ts";
import type { BundleFile } from "../../src/domain/types.ts";

function filing(id: string, draftId: string) {
  return {
    id,
    draftId,
    mode: "existing" as const,
    destinationId: "/projects/launch.md",
    actor: "agent",
    proposal: {
      directory: "/projects",
      filename: "launch.md",
      title: "Launch",
      description: "",
      tags: [],
    },
  };
}

describe("filing queue", () => {
  it("suggests only direct child directories for the active path segment", () => {
    const files = [
      { id: "/projects/website/brief.md", directory: "/projects/website" },
      { id: "/projects/writing/outline.md", directory: "/projects/writing" },
      { id: "/references/inbox/link.md", directory: "/references/inbox" },
    ] as BundleFile[];
    const directories = bundleDirectories(files);
    const context = directorySuggestionContext("/projects/we", 12, directories);

    expect(context.suggestions.map(({ directory }) => directory)).toEqual([
      "/projects/website",
    ]);
    expect(applyDirectorySuggestion("/projects/we", context, context.suggestions[0])).toBe("/projects/website");
    expect(directories).not.toContain("/references");
    expect(directorySuggestionContext("/re", 3, directories).suggestions).toEqual([]);
  });

  it("rekeys a processing draft without displacing existing destination work", () => {
    const first = filingEntry(filing("filing-first", "draft-first"));
    const second = filingEntry(filing("filing-second", "draft-second"));
    const queues = rekeyFilingQueue(
      { "/projects/launch.md": [first], "draft-second": [{ ...second, status: "preparing" }] },
      "draft-second",
      "/projects/launch.md",
      second,
    );

    expect(queues["draft-second"]).toBeUndefined();
    expect(queues["/projects/launch.md"].map((entry) => entry.filing.id)).toEqual([
      "filing-first",
      "filing-second",
    ]);
    expect(queues["/projects/launch.md"][1].status).toBe("ready");
  });

  it("keeps later append confirmations on the original target after standalone filing", () => {
    const first = filingEntry(filing("filing-first", "draft-first"));
    const second = filingEntry(filing("filing-second", "draft-second"));
    const queues = advanceFilingQueue(
      { "/projects/launch.md": [first, second] },
      "/projects/launch.md",
      "/projects/separate.md",
      "standalone",
    );

    expect(queues["/projects/launch.md"]).toEqual([second]);
    expect(queues["/projects/separate.md"]).toBeUndefined();
  });

  it("returns a failed draft preparation to editing by removing only its placeholder", () => {
    const failed = { ...filingEntry(filing("draft-one", "draft-one")), status: "error" as const };
    const other = filingEntry(filing("filing-other", "draft-other"));
    expect(dismissFailedPreparation({ "draft-one": [failed], "/projects/launch.md": [other] }, "draft-one")).toEqual({
      "/projects/launch.md": [other],
    });
  });

  it("finishes legacy draft recovery without missing filing metadata", () => {
    const preparing = { ...filingEntry(filing("draft-legacy", "draft-legacy")), status: "preparing" as const };
    const existing = filingEntry(filing("filing-other", "draft-other"));

    expect(finishDraftFiling(
      { "draft-legacy": [preparing], "/projects/launch.md": [existing] },
      "draft-legacy",
      "/legacy/recovered.md",
      null,
    )).toEqual({ "/projects/launch.md": [existing] });
  });

  it("gives a split document exactly one filing-card owner", () => {
    const entry = filingEntry(filing("filing-first", "draft-first"));
    const groups = [
      { id: "primary", tabs: ["/projects/launch.md"], activeId: "/projects/launch.md" },
      { id: "secondary", tabs: ["/projects/launch.md"], activeId: "/projects/launch.md" },
    ];

    expect(filingOwnerGroupIds(groups, "secondary", {
      "/projects/launch.md": [entry],
    })).toEqual({ "/projects/launch.md": "secondary" });
  });

  it("opens a standalone result without discarding its source tab", () => {
    const groups = [
      { id: "primary", tabs: ["/projects/launch.md"], activeId: "/projects/launch.md" },
      { id: "secondary", tabs: ["/projects/launch.md"], activeId: "/projects/launch.md" },
    ];
    const next = applyStandaloneFilingTabs(
      groups,
      "primary",
      "/projects/launch.md",
      "/projects/separate.md",
      false,
    );

    expect(next[0]).toEqual({
      id: "primary",
      tabs: ["/projects/launch.md", "/projects/separate.md"],
      activeId: "/projects/separate.md",
    });
    expect(next[1]).toEqual(groups[1]);
  });
});
