import { describe, expect, it } from "vitest";
import {
  ZipStructureException,
  assertZipStructure,
} from "../../src/library/zip-structure";

/** Minimal local-file ZIP with EOCD (empty archive). */
function emptyZip(): ArrayBuffer {
  // PK\x05\x06 + zeros + comment length 0
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, // EOCD
    0, 0, 0, 0, // disks
    0, 0, 0, 0, // entries
    0, 0, 0, 0, // cen size
    0, 0, 0, 0, // cen offset
    0, 0, // comment len
  ]);
  return eocd.buffer;
}

describe("assertZipStructure", () => {
  it("accepts a minimal EOCD", () => {
    expect(() => assertZipStructure(emptyZip())).not.toThrow();
  });

  it("rejects ZIP64 sentinels in EOCD", () => {
    const bytes = new Uint8Array(emptyZip());
    // total entries = 0xffff
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    expect(() => assertZipStructure(bytes.buffer)).toThrow(ZipStructureException);
    try {
      assertZipStructure(bytes.buffer);
    } catch (e) {
      expect((e as ZipStructureException).code).toBe("zip64");
    }
  });
});
