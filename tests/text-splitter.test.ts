import { describe, expect, it } from "vitest";

import { splitText } from "../src/indexer/text-splitter.js";

describe("splitText", () => {
  it("prefers paragraph boundaries", () => {
    const text = "Alpha paragraph.\n\nBeta paragraph is longer.\n\nGamma paragraph.";
    const chunks = splitText(text, { chunkSize: 45, chunkOverlap: 8 });

    expect(chunks[0]).toBe("Alpha paragraph.\n\nBeta paragraph is longer.");
    expect(chunks.every((chunk) => chunk.length <= 45)).toBe(true);
    expect(chunks.join(" ")).toContain("Gamma paragraph.");
  });

  it("falls back to hard boundaries for monolithic text", () => {
    const chunks = splitText("x".repeat(55), { chunkSize: 20, chunkOverlap: 5 });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.at(-1)).toBe("x".repeat(10));
  });

  it("keeps overlap while always making progress", () => {
    const chunks = splitText("one two three four five six seven", {
      chunkSize: 14,
      chunkOverlap: 4
    });

    expect(chunks[0]).toBe("one two three");
    expect(chunks.at(-1)).toBe("six seven");
    expect(chunks.every((chunk) => chunk.length <= 14)).toBe(true);
    expect(chunks.some((chunk) => chunk.startsWith("three "))).toBe(true);
  });

  it("rejects invalid sizing", () => {
    expect(() => splitText("text", { chunkSize: 10, chunkOverlap: 10 })).toThrow(
      "chunkOverlap"
    );
  });
});
