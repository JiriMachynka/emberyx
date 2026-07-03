/** Last path segment (like POSIX basename). */
export function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

/** Directory portion of a path (everything before the last segment). */
export function dirname(p: string): string {
  return p.replace(/\/[^/]+$/, "");
}
