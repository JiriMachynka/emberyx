import { describe, expect, it } from "vitest";
import { createAnsiScreen } from "@/lib/ansi";

describe("createAnsiScreen", () => {
  it("splits plain text into lines", () => {
    const s = createAnsiScreen(100);
    s.push("hello\nworld\npart");
    expect(s.lines()).toEqual(["hello", "world", "part"]);
  });

  it("overwrites the line on carriage return, like a progress bar", () => {
    const s = createAnsiScreen(100);
    s.push("downloading 10%\rdownloading 55%\rdownloading 100%\ndone\n");
    expect(s.lines()).toEqual(["downloading 100%", "done", ""]);
  });

  it("keeps SGR color codes in the line", () => {
    const s = createAnsiScreen(100);
    s.push("\x1b[32mok\x1b[0m fine\n");
    expect(s.lines()).toEqual(["\x1b[32mok\x1b[0m fine", ""]);
  });

  it("treats SGR after \\r as part of the repaint", () => {
    const s = createAnsiScreen(100);
    s.push("spinner |\r\x1b[33mspinner /\x1b[0m");
    expect(s.lines()).toEqual(["\x1b[33mspinner /\x1b[0m"]);
  });

  it("replaces the prompt when zsh redraws from column one", () => {
    const s = createAnsiScreen(100);
    s.push("% c");
    s.push("\x1b[1G% clear");
    expect(s.lines()).toEqual(["% clear"]);
  });

  it("erase-line clears the current line", () => {
    const s = createAnsiScreen(100);
    s.push("noise\x1b[2Kclean");
    expect(s.lines()).toEqual(["clean"]);
  });

  it("drops cursor movement, alt-screen toggles, and OSC titles", () => {
    const s = createAnsiScreen(100);
    s.push("\x1b[2Aup\x1b[?1049h\x1b]0;my title\x07visible\x1b[?1049l\n");
    expect(s.lines()).toEqual(["upvisible", ""]);
  });

  it("buffers an escape sequence split across chunks", () => {
    const s = createAnsiScreen(100);
    s.push("a\x1b[3");
    s.push("2mgreen\x1b[0m\n");
    expect(s.lines()).toEqual(["a\x1b[32mgreen\x1b[0m", ""]);
  });

  it("buffers an OSC sequence split across chunks", () => {
    const s = createAnsiScreen(100);
    s.push("x\x1b]0;tit");
    s.push("le\x07y");
    expect(s.lines()).toEqual(["xy"]);
  });

  it("erase-screen wipes the buffer", () => {
    const s = createAnsiScreen(100);
    s.push("old\nolder\n\x1b[2Jfresh");
    expect(s.lines()).toEqual(["fresh"]);
  });

  it("caps committed lines at the limit", () => {
    const s = createAnsiScreen(3);
    s.push("1\n2\n3\n4\n5\ntail");
    expect(s.lines()).toEqual(["3", "4", "5", "tail"]);
  });

  it("drops bells and other control bytes", () => {
    const s = createAnsiScreen(100);
    s.push("ding\x07dong\tend\n");
    expect(s.lines()).toEqual(["dingdong\tend", ""]);
  });

  it("bumps version on every push and on clear", () => {
    const s = createAnsiScreen(100);
    const v0 = s.version();
    s.push("a");
    expect(s.version()).toBeGreaterThan(v0);
    const v1 = s.version();
    s.clear();
    expect(s.version()).toBeGreaterThan(v1);
    expect(s.lines()).toEqual([""]);
  });
});
