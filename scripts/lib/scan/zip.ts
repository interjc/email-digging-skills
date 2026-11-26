import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CD_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT = 65535;
const EOCD_MIN_SIZE = 22;
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

export function isZipBuffer(buf: Buffer): boolean {
  if (buf.length < 4) {
    return false;
  }
  const sig = buf.readUInt32LE(0);
  return sig === LOCAL_HEADER_SIGNATURE || sig === EOCD_SIGNATURE;
}

function findEocdOffset(buf: Buffer): number {
  if (buf.length < EOCD_MIN_SIZE) {
    return -1;
  }
  const minOffset = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_ZIP_COMMENT);
  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= minOffset; pos -= 1) {
    if (buf.readUInt32LE(pos) === EOCD_SIGNATURE) {
      const commentLen = buf.readUInt16LE(pos + 20);
      if (pos + EOCD_MIN_SIZE + commentLen <= buf.length) {
        return pos;
      }
    }
  }
  return -1;
}

/**
 * Minimal in-memory ZIP reader using the Central Directory so entries written
 * with streaming data descriptors (common in XLSX writers like DuckDB/Excel)
 * are decoded accurately. Supports STORED (0) and DEFLATE (8).
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocdOffset = findEocdOffset(buf);
  if (eocdOffset < 0) {
    throw new Error('Invalid ZIP archive: end of central directory not found');
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > buf.length) {
    throw new Error('Invalid ZIP archive: central directory out of bounds');
  }

  const entries: ZipEntry[] = [];
  let offset = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buf.length) {
      throw new Error('Invalid ZIP archive: truncated central directory header');
    }
    if (buf.readUInt32LE(offset) !== CD_HEADER_SIGNATURE) {
      throw new Error('Invalid ZIP archive: bad central directory signature');
    }

    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    const nextOffset = nameEnd + extraLen + commentLen;
    if (nextOffset > buf.length) {
      throw new Error('Invalid ZIP archive: truncated central directory entry');
    }

    const isUtf8 = (flags & 0x0800) !== 0;
    const name = buf.subarray(nameStart, nameEnd).toString(isUtf8 ? 'utf8' : 'latin1');
    offset = nextOffset;

    // Skip directory entries
    if (name.endsWith('/')) {
      continue;
    }

    if (localHeaderOffset + 30 > buf.length) {
      throw new Error(`Invalid ZIP archive: local header out of bounds for ${name}`);
    }
    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`Invalid ZIP archive: bad local header signature for ${name}`);
    }

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buf.length) {
      throw new Error(`Invalid ZIP archive: compressed data out of bounds for ${name}`);
    }

    const rawSlice = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(rawSlice);
    } else if (method === 8) {
      data = inflateRawSync(rawSlice, { maxOutputLength: MAX_INFLATE_BYTES });
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    entries.push({ name, data });
  }

  return entries;
}
