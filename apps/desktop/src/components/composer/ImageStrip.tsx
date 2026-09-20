import { ScanText, X } from "lucide-react";
import type { ChatImage } from "@/lib/chatMessage";
import { imageSrc } from "@/components/chat/imageSrc";

export function ImageStrip({
  images,
  onPreview,
  onRemove,
}: {
  images: ChatImage[];
  onPreview: (dataUrl: string, a11y?: string) => void;
  onRemove: (id: string) => void;
}) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-5 pt-4">
      {images.map((img) => (
        <div
          key={img.id}
          className="relative size-16 overflow-hidden rounded-lg border border-border outline outline-1 outline-white/10"
        >
          <button
            type="button"
            onClick={() => onPreview(imageSrc(img), img.snapshot?.a11y)}
            className="block size-full"
            title={
              img.snapshot
                ? `${img.snapshot.app}${img.snapshot.title ? ` — ${img.snapshot.title}` : ""}`
                : undefined
            }
          >
            <img src={imageSrc(img)} alt="" className="size-full object-cover" />
          </button>
          {/* A snapshot names what was captured; the badge marks a tree
              waiting under the image in the lightbox. */}
          {img.snapshot && (
            <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-xs leading-4 text-foreground">
              {img.snapshot.app}
            </span>
          )}
          {img.snapshot?.a11y && (
            <span
              title="Includes accessibility tree"
              className="absolute left-1 top-1 rounded bg-background/80 p-0.5 text-foreground"
            >
              <ScanText className="size-3" />
            </span>
          )}
          {/* Always visible: a remove affordance that only appears on
              hover is one a trackpad user has to go hunting for. */}
          <button
            type="button"
            title="Remove"
            onClick={() => onRemove(img.id)}
            className="absolute right-1 top-1 rounded-full bg-background/70 p-0.5 text-foreground transition-colors hover:bg-background"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
