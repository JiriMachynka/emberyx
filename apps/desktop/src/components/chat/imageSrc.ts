import type { ChatImage } from "@/hooks/useAgentChat";

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
export const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;
