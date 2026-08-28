import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileRef, FileRefProject } from "@/components/FileRef";
import { onOpenFileRequest } from "@/lib/openFileRequest";
import { fileKeys } from "@/lib/queries";

// React only batches through act() when it knows it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "/home/p";
const FILES = ["src/lib/providers.ts", "src/components/ChatPane.tsx"];

/**
 * Mount a reference inside a project whose file list is already cached. The
 * Tauri boundary is left alone deliberately: mocking `@tauri-apps/api/core`
 * here leaks into every other file under `bun test`, which shares one process.
 */
const mount = async (label: string, files: string[] | null = FILES) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (files) client.setQueryData(fileKeys.all(PROJECT), files);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <FileRefProject value={PROJECT}>
          <FileRef path={label} label={label} />
        </FileRefProject>
      </QueryClientProvider>
    );
  });
  return container;
};

describe("FileRef", () => {
  it("wears the filetype icon of the file it names", async () => {
    const container = await mount("providers.ts");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/file-icons/typescript.svg"
    );
  });

  it("opens the resolved project file when clicked", async () => {
    const opened: string[] = [];
    const stop = onOpenFileRequest((path) => opened.push(path));
    const container = await mount("providers.ts");

    const clickable = container.querySelector("span[role=button]");
    expect(clickable).not.toBeNull();
    await act(async () => {
      clickable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual(["/home/p/src/lib/providers.ts"]);
    stop();
  });

  it("stays inert when the project has no such file", async () => {
    const opened: string[] = [];
    const stop = onOpenFileRequest((path) => opened.push(path));
    const container = await mount("nowhere.ts");

    expect(container.querySelector("span[role=button]")).toBeNull();
    await act(async () => {
      container
        .querySelector("span")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toEqual([]);
    stop();
  });

  it("stays inert while the file list is still unknown", async () => {
    const container = await mount("providers.ts", null);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("span[role=button]")).toBeNull();
  });
});
