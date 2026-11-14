// Reads a ZIP's central directory (an XLSX is a ZIP) without unpacking it, so a
// file can be rejected before exceljs expands it in memory.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** True when the buffer starts like a ZIP ("PK\x03\x04"). */
export const looksLikeZip = (buf) =>
  buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIGNATURE;

/**
 * Lists the entries of a ZIP: `[{ name, compressedSize, uncompressedSize }]`.
 * Returns null when the structure is broken or uses ZIP64 (never needed for a
 * 5 MB spreadsheet, and a common trick to hide sizes).
 */
export function listZipEntries(buf) {
  if (!looksLikeZip(buf) || buf.length < EOCD_MIN) return null;

  // The end-of-central-directory record sits at the end, before an optional comment.
  const from = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  let eocd = -1;
  for (let i = buf.length - EOCD_MIN; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    return null;
  if (offset + size > eocd) return null;

  const entries = [];
  let p = offset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE)
      return null;
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      return null;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    entries.push({ name, compressedSize, uncompressedSize });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
