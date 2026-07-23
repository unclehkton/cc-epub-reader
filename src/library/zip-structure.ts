/**
 * Lightweight ZIP structural guards before JSZip full inflate.
 * Release 0.1: reject ZIP64 and pathological central directories when detectable.
 */

export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ZIP_PATH_LENGTH = 512;

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const CEN_SIG = 0x02014b50;

export type ZipStructureError =
  | "zip64"
  | "too-many-entries"
  | "path-too-long"
  | "malformed-eocd"
  | "traversal";

export class ZipStructureException extends Error {
  readonly code: ZipStructureError;
  constructor(code: ZipStructureError, message: string) {
    super(message);
    this.code = code;
    this.name = "ZipStructureException";
  }
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Scan for End of Central Directory and enforce basic limits.
 * Does not fully parse every CEN record; catches common bomb patterns early.
 */
export function assertZipStructure(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22) {
    throw new ZipStructureException("malformed-eocd", "ZIP too small");
  }

  // Search EOCD in last 64 KiB (comment can be up to 65535)
  const maxScan = Math.min(bytes.length, 65535 + 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= bytes.length - maxScan && i >= 0; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    // May still be valid ZIP that JSZip can open; soft-fail only if ZIP64 locator found
    if (hasSignature(bytes, ZIP64_EOCD_LOCATOR)) {
      throw new ZipStructureException("zip64", "ZIP64 not supported in Release 0.1");
    }
    return;
  }

  const view = new DataView(buffer, eocd, Math.min(22, bytes.length - eocd));
  const sig = readU32(view, 0);
  if (sig !== EOCD_SIG) {
    throw new ZipStructureException("malformed-eocd", "Bad EOCD signature");
  }

  const totalEntries = readU16(view, 10);
  const sizeCen = readU32(view, 12);
  const offsetCen = readU32(view, 16);

  // ZIP64 uses 0xffff / 0xffffffff sentinels
  if (
    totalEntries === 0xffff ||
    sizeCen === 0xffffffff ||
    offsetCen === 0xffffffff
  ) {
    throw new ZipStructureException("zip64", "ZIP64 not supported in Release 0.1");
  }

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new ZipStructureException(
      "too-many-entries",
      `ZIP entry count ${totalEntries} exceeds ${MAX_ZIP_ENTRIES}`,
    );
  }

  if (offsetCen + sizeCen > bytes.length) {
    throw new ZipStructureException("malformed-eocd", "Central directory out of bounds");
  }

  // Spot-check central directory paths for traversal / length
  let pos = offsetCen;
  const end = offsetCen + sizeCen;
  let seen = 0;
  while (pos + 46 <= end && seen < totalEntries) {
    if (pos + 4 > bytes.length) break;
    const cenView = new DataView(buffer, pos, Math.min(46, bytes.length - pos));
    if (readU32(cenView, 0) !== CEN_SIG) break;
    const nameLen = readU16(cenView, 28);
    const extraLen = readU16(cenView, 30);
    const commentLen = readU16(cenView, 32);
    if (nameLen > MAX_ZIP_PATH_LENGTH) {
      throw new ZipStructureException("path-too-long", "ZIP path too long");
    }
    const nameStart = pos + 46;
    if (nameStart + nameLen > bytes.length) break;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLen);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
    if (name.includes("..") || name.includes("\\") || name.startsWith("/")) {
      // Soft: only reject clear traversal
      if (
        name.split(/[/\\]/).includes("..") ||
        name.startsWith("/") ||
        name.startsWith("\\")
      ) {
        throw new ZipStructureException("traversal", `Unsafe ZIP path: ${name}`);
      }
    }
    pos = nameStart + nameLen + extraLen + commentLen;
    seen += 1;
  }
}

function hasSignature(bytes: Uint8Array, sig: number): boolean {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  const limit = Math.min(bytes.length - 4, 1024 * 1024);
  for (let i = 0; i < limit; i += 1) {
    if (
      bytes[i] === b0 &&
      bytes[i + 1] === b1 &&
      bytes[i + 2] === b2 &&
      bytes[i + 3] === b3
    ) {
      return true;
    }
  }
  return false;
}
