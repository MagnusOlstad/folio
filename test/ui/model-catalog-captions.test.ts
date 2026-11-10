import { describe, expect, it } from "vitest";
import type { MlxStatus } from "../../src/domain/types.ts";
import { selectedWorkspaceModelCatalog, workspaceModelPurpose } from "../../src/features/workspace/model/model-catalog.ts";
import { imageDownloadName } from "../../src/features/workspace/model/image-size.ts";

const status = (overrides: Partial<MlxStatus>) => ({ available: true, helperAvailable: true, models: [], ...overrides }) as unknown as MlxStatus;

describe("caption model in the workspace pane", () => {
  it("adds the selected caption model only when one is chosen", () => {
    const base = status({ selectedGenerationModel: "gemma4", selectedCaptionModel: null });
    expect(selectedWorkspaceModelCatalog(base).map(({ id }) => id)).not.toContain("qwen35");
    const withCaption = status({ selectedGenerationModel: "gemma4", selectedCaptionModel: "qwen35" });
    expect(selectedWorkspaceModelCatalog(withCaption).map(({ id }) => id)).toContain("qwen35");
  });

  it("labels the purpose by actual use", () => {
    const qwen = { id: "qwen35", purpose: "Filing & Ask" } as const;
    const gemma = { id: "gemma4", purpose: "Filing & Ask" } as const;
    const both = status({ selectedGenerationModel: "gemma4", selectedCaptionModel: "gemma4" });
    const split = status({ selectedGenerationModel: "gemma4", selectedCaptionModel: "qwen35" });
    expect(workspaceModelPurpose(qwen, split)).toBe("Image descriptions");
    expect(workspaceModelPurpose(gemma, both)).toBe("Filing & Ask · Image descriptions");
    expect(workspaceModelPurpose(gemma, split)).toBe("Filing & Ask");
    expect(workspaceModelPurpose(gemma, null)).toBe("Filing & Ask");
  });
});

describe("imageDownloadName", () => {
  it("uses the decoded last segment of the asset path", () => {
    expect(imageDownloadName("/api/assets?path=%2Fassets%2Fmy%20shot.png", "image/png")).toBe("my shot.png");
    expect(imageDownloadName("/assets/a.png?v=2#x", "image/png")).toBe("a.png");
  });
  it("falls back to image plus the MIME extension", () => {
    expect(imageDownloadName("/assets/", "image/jpeg")).toBe("image.jpg");
    expect(imageDownloadName("", "image/webp; charset=x")).toBe("image.webp");
    expect(imageDownloadName("", "application/octet-stream")).toBe("image.png");
  });
});
