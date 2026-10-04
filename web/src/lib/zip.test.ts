import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, zip, type ZipEntry } from "./zip";

const entry = (path: string, data: Uint8Array): ZipEntry => ({
  path,
  data: new Blob([data as Uint8Array<ArrayBuffer>]),
  crc: crc32(data),
  size: data.length,
});

describe("zip", () => {
  it("computes standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("produces an archive that unzip accepts", async () => {
    const blob = zip([
      entry("mods/a.AAAA.jar", new TextEncoder().encode("hello")),
      entry("resourcepacks/b.BBBB.zip", new Uint8Array([0, 1, 2, 3])),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "mcd-zip-"));
    const file = join(dir, "out.zip");
    writeFileSync(file, new Uint8Array(await blob.arrayBuffer()));
    const listing = execFileSync("unzip", ["-t", file]).toString();
    expect(listing).toContain("No errors detected");
    expect(execFileSync("unzip", ["-p", file, "mods/a.AAAA.jar"]).toString()).toBe("hello");
  });
});
