/** MIME types we will encode as a vision block. */
const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * The MIME type to send for a dropped or pasted file.
 *
 * Finder (and some webviews) hand over a `File` with an empty `type` even for
 * a real PNG; the name is then the only signal. `null` means this is not an
 * image we can attach.
 */
export const mimeForImageFile = (file: File): string | null => {
  if (file.type.startsWith("image/")) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext ? (BY_EXT[ext] ?? null) : null;
};
