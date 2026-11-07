// Reads the code points a font covers from its `cmap` table (formats 4 and 12 only).
// Font files are untrusted input: every offset and length is checked against the buffer, and a
// malformed font is rejected with an Error instead of being read out of range or looped over.

const MAX_CODE_POINT = 0x10ffff;
const MAX_TABLES = 4096;
const MAX_SUBTABLES = 256;

function fail(message) {
  throw new Error(`Malformed font: ${message}`);
}

export function codePoints(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('codePoints expects a Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const u16 = (offset) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + 2 > length) fail(`offset ${offset} outside the file`);
    return view.getUint16(offset);
  };
  const u32 = (offset) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > length) fail(`offset ${offset} outside the file`);
    return view.getUint32(offset);
  };

  if (length < 12) fail('shorter than an sfnt header');
  const version = u32(0);
  // 0x00010000 (TrueType), 'OTTO' (CFF), 'true' (Apple TrueType). Collections ('ttcf') are not supported.
  if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) fail(`unsupported sfnt version 0x${version.toString(16)}`);
  const numTables = u16(4);
  if (numTables === 0 || numTables > MAX_TABLES) fail(`implausible table count ${numTables}`);
  if (12 + numTables * 16 > length) fail('table directory runs past the end of the file');

  let cmapOffset = -1;
  let cmapLength = 0;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (u32(record) === 0x636d6170) { // 'cmap'
      cmapOffset = u32(record + 8);
      cmapLength = u32(record + 12);
      break;
    }
  }
  if (cmapOffset < 0) fail('no cmap table');
  if (cmapOffset > length || cmapLength > length - cmapOffset) fail('cmap table runs past the end of the file');
  if (cmapLength < 4) fail('cmap table too short');
  const cmapEnd = cmapOffset + cmapLength;
  const inCmap = (offset, size) => offset >= cmapOffset && size >= 0 && offset + size <= cmapEnd;

  const numSubtables = u16(cmapOffset + 2);
  if (numSubtables > MAX_SUBTABLES) fail(`implausible cmap subtable count ${numSubtables}`);
  if (!inCmap(cmapOffset + 4, numSubtables * 8)) fail('cmap encoding records run past the table');

  const result = new Set();
  const done = new Set();
  for (let i = 0; i < numSubtables; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    const platform = u16(record);
    const encoding = u16(record + 2);
    // Unicode platform, or Windows Unicode BMP (3/1) and full repertoire (3/10).
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const subtable = cmapOffset + u32(record + 4);
    if (done.has(subtable)) continue;
    done.add(subtable);
    if (!inCmap(subtable, 4)) fail('cmap subtable offset outside the table');
    const format = u16(subtable);
    if (format === 4) readFormat4(subtable);
    else if (format === 12) readFormat12(subtable);
  }
  return result;

  function readFormat4(start) {
    if (!inCmap(start, 16)) fail('format 4 header runs past the table');
    const tableLength = u16(start + 2);
    if (tableLength < 16 || !inCmap(start, tableLength)) fail('format 4 length outside the table');
    const end = start + tableLength;
    const segCountX2 = u16(start + 6);
    if (segCountX2 % 2 !== 0 || segCountX2 === 0) fail('format 4 segment count invalid');
    const segCount = segCountX2 / 2;
    const endCodes = start + 14;
    const startCodes = endCodes + segCountX2 + 2; // skips reservedPad
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;
    if (idRangeOffsets + segCountX2 > end) fail('format 4 arrays run past the subtable');
    let previousEnd = -1;
    for (let s = 0; s < segCount; s += 1) {
      const last = u16(endCodes + s * 2);
      const first = u16(startCodes + s * 2);
      if (first > last) fail('format 4 segment start after end');
      if (last <= previousEnd && !(last === 0xffff && previousEnd === 0xffff)) fail('format 4 segments not in ascending order');
      if (first <= previousEnd && previousEnd !== -1) fail('format 4 segments overlap');
      previousEnd = last;
      if (first === 0xffff) continue; // the terminating segment
      const delta = u16(idDeltas + s * 2);
      const rangeOffsetAt = idRangeOffsets + s * 2;
      const rangeOffset = u16(rangeOffsetAt);
      for (let code = first; code <= last && code < 0xffff; code += 1) {
        let glyph;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const at = rangeOffsetAt + rangeOffset + (code - first) * 2;
          if (at + 2 > end) fail('format 4 glyph index outside the subtable');
          glyph = u16(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) result.add(code);
      }
    }
  }

  function readFormat12(start) {
    if (!inCmap(start, 16)) fail('format 12 header runs past the table');
    const tableLength = u32(start + 4);
    if (tableLength < 16 || !inCmap(start, tableLength)) fail('format 12 length outside the table');
    const numGroups = u32(start + 12);
    if (numGroups > (tableLength - 16) / 12) fail('format 12 group count runs past the subtable');
    let previousEnd = -1;
    for (let g = 0; g < numGroups; g += 1) {
      const group = start + 16 + g * 12;
      const first = u32(group);
      const last = u32(group + 4);
      const firstGlyph = u32(group + 8);
      if (first > last || last > MAX_CODE_POINT) fail('format 12 group range invalid');
      // Groups must ascend without overlap, which also bounds the total work at one pass over Unicode.
      if (first <= previousEnd) fail('format 12 groups not in ascending order');
      previousEnd = last;
      for (let code = first; code <= last; code += 1) {
        if (firstGlyph + (code - first) !== 0) result.add(code);
      }
    }
  }
}
