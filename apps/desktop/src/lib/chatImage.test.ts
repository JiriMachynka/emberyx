import { describe, expect, it } from "vitest";
import { mimeForImageFile } from "@/lib/chatImage";

const file = (name: string, type: string) =>
  new File(["x"], name, { type });

describe("mimeForImageFile", () => {
  it("trusts a browser-supplied image type", () => {
    expect(mimeForImageFile(file("shot.png", "image/png"))).toBe("image/png");
  });

  it("recovers the type from the name when the webview leaves it blank", () => {
    // Tauri/Finder drops often arrive as application/octet-stream or "".
    expect(mimeForImageFile(file("photo.JPEG", ""))).toBe("image/jpeg");
    expect(mimeForImageFile(file("a.webp", "application/octet-stream"))).toBe(
      "image/webp"
    );
  });

  it("rejects a file that is not an image", () => {
    expect(mimeForImageFile(file("notes.txt", "text/plain"))).toBeNull();
    expect(mimeForImageFile(file("notes.txt", ""))).toBeNull();
  });
});
