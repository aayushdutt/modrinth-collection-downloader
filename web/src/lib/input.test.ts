import { describe, expect, it } from "vitest";
import { parseCollectionInput, readCollectionInput } from "./input";

describe("parseCollectionInput", () => {
  it("accepts ids and URLs", () => {
    expect(parseCollectionInput(" YyGKtxlz ")).toBe("YyGKtxlz");
    expect(parseCollectionInput("https://modrinth.com/collection/YyGKtxlz")).toBe("YyGKtxlz");
    expect(parseCollectionInput("modrinth.com/collection/YyGKtxlz?x=1")).toBe("YyGKtxlz");
    expect(parseCollectionInput("https://www.modrinth.com/collection/abc/")).toBe("abc");
  });
});

describe("readCollectionInput", () => {
  it("explains links that aren't collections", () => {
    expect(readCollectionInput("  ")).toEqual({ error: "Paste a collection link or ID." });
    expect(readCollectionInput("https://modrinth.com/mod/sodium")).toHaveProperty("error");
    expect(readCollectionInput("modrinth.com/user/someone/collections")).toEqual({
      error: "That's a profile. Open one of its collections and paste that link.",
    });
    expect(readCollectionInput("not a link")).toHaveProperty("error");
  });

  it("returns the id for collection links", () => {
    expect(readCollectionInput("https://modrinth.com/collection/YyGKtxlz")).toEqual({ id: "YyGKtxlz" });
  });
});
