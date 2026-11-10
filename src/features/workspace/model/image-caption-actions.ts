import { createContext, useContext } from "react";
import type { ImageCaptionModelId } from "../../../lib/assets.ts";

/** What the image description panel can ask the app to do when no usable model exists. */
export type ImageCaptionActions = {
  openModelSettings: () => void;
  installModel: (id: ImageCaptionModelId) => void;
};

export const ImageCaptionActionsContext = createContext<ImageCaptionActions | null>(null);

export function useImageCaptionActions() {
  return useContext(ImageCaptionActionsContext);
}
