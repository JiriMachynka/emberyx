import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import { FileTree } from "@/components/editor/FileTree";
import { fileKeys } from "@/lib/queries";
import type { DirEntry } from "@/types";
import { flush, renderWithQuery, stubLayout } from "@/test-utils/render";

const entry = (path: string, isDir: boolean): DirEntry => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  isDir,
});

afterEach(cleanup);

describe("FileTree", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubLayout();
  });
  afterEach(() => restore());

  it("unfolds and highlights a file opened from the finder", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(fileKeys.dir("/p"), [
      entry("/p/src", true),
      entry("/p/readme.md", false),
    ]);
    client.setQueryData(fileKeys.dir("/p/src"), [
      entry("/p/src/cart-process.yaml", false),
    ]);
    renderWithQuery(
      <FileTree
        root="/p"
        name="p"
        selected="/p/src/cart-process.yaml"
        dirtyPaths={new Set()}
        onSelect={() => {}}
      />,
      client
    );
    await flush();
    expect(
      screen.getByRole("button", { name: "cart-process.yaml" }).getAttribute(
        "aria-current"
      )
    ).toBe("true");
  });
});
