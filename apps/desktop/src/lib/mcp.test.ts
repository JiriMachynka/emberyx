import { describe, expect, it } from "vitest";
import {
  buildMcpTransport,
  entryFor,
  isValidMcpName,
  transportSummary,
  type McpServerInfo,
} from "./mcp";

describe("transportSummary", () => {
  it("joins a stdio definition into a command line", () => {
    expect(
      transportSummary({
        kind: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: {},
      })
    ).toBe("npx -y @upstash/context7-mcp");
  });

  it("shows the URL for a remote definition", () => {
    expect(
      transportSummary({ kind: "http", url: "https://mcp.example.com/mcp", headers: {} })
    ).toBe("https://mcp.example.com/mcp");
  });
});

describe("buildMcpTransport", () => {
  const base = { commandLine: "", url: "", env: [], headers: [] };

  it("tokenizes the command line with quotes as grouping, not syntax", () => {
    expect(
      buildMcpTransport({
        ...base,
        kind: "stdio",
        commandLine: 'npx -y "@scope/pkg with space" --flag',
      })
    ).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@scope/pkg with space", "--flag"],
      env: {},
    });
  });

  it("is null until a stdio command exists", () => {
    expect(buildMcpTransport({ ...base, kind: "stdio", commandLine: "  " })).toBeNull();
  });

  it("drops empty env names and trims the url", () => {
    expect(
      buildMcpTransport({
        ...base,
        kind: "http",
        url: "  https://mcp.example.com/mcp  ",
        headers: [
          { name: "", value: "ignored" },
          { name: "Authorization", value: "Bearer x" },
        ],
      })
    ).toEqual({
      kind: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("is null until a remote url exists", () => {
    expect(buildMcpTransport({ ...base, kind: "http", url: "" })).toBeNull();
  });
});

describe("isValidMcpName", () => {
  it("allows the characters every harness accepts", () => {
    expect(isValidMcpName("context7")).toBe(true);
    expect(isValidMcpName("my-server_1")).toBe(true);
  });

  it("rejects shell-ish names", () => {
    expect(isValidMcpName("")).toBe(false);
    expect(isValidMcpName("has space")).toBe(false);
    expect(isValidMcpName("dot.name")).toBe(false);
    expect(isValidMcpName("slash/ed")).toBe(false);
  });
});

describe("entryFor", () => {
  const server: McpServerInfo = {
    name: "context7",
    differs: false,
    harnesses: [
      {
        harness: "claude",
        enabled: true,
        configPath: "/home/u/.claude.json",
        transport: { kind: "http", url: "https://mcp.context7.com/mcp", headers: {} },
      },
    ],
  };

  it("finds a harness entry or undefined", () => {
    expect(entryFor(server, "claude")?.configPath).toBe("/home/u/.claude.json");
    expect(entryFor(server, "kilo")).toBeUndefined();
  });
});
