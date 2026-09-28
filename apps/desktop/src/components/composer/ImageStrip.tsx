import { X } from "lucide-react";
import type { ChatImage } from "@/lib/chatMessage";
import { imageSrc } from "@/components/chat/imageSrc";

export function ImageStrip({
  images,
  onPreview,
  onRemove,
}: {
  images: ChatImage[];
  onPreview: (dataUrl: string) => void;
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
            onClick={() => onPreview(imageSrc(img))}
            className="block size-full"
          >
            <img src={imageSrc(img)} alt="" className="size-full object-cover" />
          </button>
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
