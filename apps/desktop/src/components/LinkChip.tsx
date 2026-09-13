import { useState, type ComponentProps } from "react";
import { Globe } from "lucide-react";
import {
  faviconSrc,
  isAutolinkText,
  linkLabel,
  parseHttpUrl,
} from "@/lib/linkRef";
import { cn } from "@/lib/utils";

/**
 * A chat link as a chip: the site's favicon and a short label. Same shape as
 * a file reference — muted pill, icon, truncated name — so a pasted URL
 * doesn't sit there as a raw underline in the bubble.
 *
 * Non-http hrefs (mailto, relative) keep the previous underlined treatment.
 */
export function LinkChip({
  href,
  children,
  className,
  ...rest
}: ComponentProps<"a">) {
  const url = typeof href === "string" ? parseHttpUrl(href) : null;
  const [iconFailed, setIconFailed] = useState(false);

  if (url === null) {
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn("text-primary underline underline-offset-2", className)}
      >
        {children}
      </a>
    );
  }

  const label =
    typeof children === "string" && isAutolinkText(children, href ?? "", url)
      ? linkLabel(url)
      : (children ?? linkLabel(url));

  return (
    <a
      {...rest}
      href={url.href}
      target="_blank"
      rel="noreferrer"
      title={url.href}
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded bg-muted px-1.5 py-0.5 align-baseline text-[0.9em] text-foreground no-underline outline-none transition-colors hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {iconFailed ? (
        <Globe
          className="size-3.5 translate-y-0.5 self-center text-muted-foreground"
          aria-hidden
        />
      ) : (
        <img
          src={faviconSrc(url.hostname)}
          alt=""
          aria-hidden
          className="size-3.5 translate-y-0.5 self-center"
          onError={() => setIconFailed(true)}
        />
      )}
      <span className="truncate">{label}</span>
    </a>
  );
}
