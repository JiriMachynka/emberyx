import type { ChatImage } from "@/hooks/useAgentChat";

/** Anthropic downsizes vision inputs past this; do it client-side to keep the
 *  base64 (which lives in the in-memory message history) small. */
const MAX_EDGE = 1568;

export const processImage = (file: File, mediaType: string): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const strip = (url: string, type: string): ChatImage => ({
        id: crypto.randomUUID(),
        mediaType: type,
        data: url.slice(url.indexOf(",") + 1),
      });
      const img = new Image();
      img.onerror = () => resolve(strip(dataUrl, mediaType));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1) {
          resolve(strip(dataUrl, mediaType));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(strip(dataUrl, mediaType));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const type = mediaType === "image/png" ? "image/png" : "image/jpeg";
        resolve(strip(canvas.toDataURL(type, 0.9), type));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
