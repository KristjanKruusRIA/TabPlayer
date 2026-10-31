// TablEdit (.tef) reader, experimental.
//
// The layout below is documented in docs/validation/2026-10-31-gp8-tablature-tef-import.md with each fact marked as
// confirmed by a public source or guessed. No real .tef file was available while this was written. The MuseScore
// TablEdit importer (GPL) was read for layout facts only; no code or structure is copied.
//
// The input is untrusted: every read is bounds-checked, every count is capped and checked against the bytes that remain
// before anything is allocated, nothing recurses, and every failure is a TablEditError with a message for the user.

import { ByteReader, ImportReport, IMPORT_FILE_BYTES } from './import-support';

export class TablEditError extends Error {
  constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = 'TablEditError'; }
}

export const TEF_LIMITS = {
  fileBytes: IMPORT_FILE_BYTES,
  measures: 4000,
  instruments: 32,
  stringsPerInstrument: 12,
  events: 100000,
  readingListItems: 2000,
} as const;

/** Header pointer and field offsets, from the MuseScore reader (read for facts). */
const OFFSET = { tbed: 0x38, contents: 0x3c, title: 0x40, subtitle: 0x44, comment: 0x48, notes: 0x4c, measures: 0x5c, instruments: 0x60, readingList: 0x80, link: 0x84, copyright: 0x8c, oldNum: 0xca } as const;
const HEADER_BYTES = 0xd0;
const MEASURE_BYTES = 8;
const INSTRUMENT_BYTES = 68;
const END_OF_CONTENTS = 0xffffffff;
const TBED = 0x64656274;
const TBED_REVERSED = 0x74626564;

export interface TefInstrument {
  strings: number; midi: number; capo: number; name: string;
  /** MIDI pitch of each open string, string 1 (highest, top tab line) first. */
  tuning: number[];
  /** Zero-based index of this instrument's first string among all strings in the file. */
  firstString: number;
}
export interface TefMeasure { pickup: boolean; key: number; numerator: number; denominator: number }
export interface TefEvent {
  /** Time in 64ths of a whole note from the start of the file. */
  position: number;
  /** Zero-based string among all strings of all instruments. */
  string: number;
  kind: 'note' | 'rest';
  fret: number; code: number; tie: boolean; voice: 0 | 1;
  grace: { fret: number } | null;
}
export interface TefDocument {
  tempo: number; title: string; subtitle: string; copyright: string;
  measures: TefMeasure[]; instruments: TefInstrument[]; readingList: [number, number][]; events: TefEvent[];
  totalStrings: number;
  report: ImportReport;
}

export function isTablEditBytes(bytes: Uint8Array) {
  if (bytes.length < OFFSET.tbed + 4) return false;
  const word = (bytes[OFFSET.tbed] | bytes[OFFSET.tbed + 1] << 8 | bytes[OFFSET.tbed + 2] << 16 | bytes[OFFSET.tbed + 3] << 24) >>> 0;
  return word === TBED || word === TBED_REVERSED;
}

function tooLarge() { return new TablEditError('This TablEdit file is too large to import safely (too many notes or measures).'); }

class Reader extends ByteReader {
  constructor(bytes: Uint8Array) { super(bytes, 'TablEdit', message => new TablEditError(message)); }
  u32At(offset: number) { this.seek(offset); return this.u32(); }
  /** A text stored behind a pointer: a 16 bit size that includes the terminator, the characters, then the terminator. */
  textAt(pointer: number) {
    if (pointer === 0) return '';
    this.seek(pointer);
    const size = this.u16();
    if (size === 0) return '';
    this.need(size);
    let out = '';
    for (let i = 0; i < size - 1; i++) {
      const c = this.bytes[this.pos + i];
      out += c < 32 ? ' ' : String.fromCharCode(c);
    }
    this.pos += size;
    return out.trim();
  }
}

function readTable(r: Reader, pointer: number, what: string, max: number, minStride: number, header: number) {
  r.seek(pointer);
  const structSize = r.u16(), count = r.u16();
  r.skip(header - 4);
  if (count > max) throw new TablEditError(`The TablEdit file declares too many ${what} (${count}).`);
  const stride = Math.max(minStride, structSize);
  if (stride * count > r.remaining) throw new TablEditError('The TablEdit file is truncated or damaged (more records declared than data remains).');
  return { count, stride, start: r.pos };
}

export function parseTablEdit(bytes: Uint8Array): TefDocument {
  if (!(bytes instanceof Uint8Array)) throw new TablEditError('Invalid TablEdit data.');
  if (bytes.length > TEF_LIMITS.fileBytes) throw new TablEditError('The TablEdit file is larger than the 16 MiB import limit.');
  try { return read(new Reader(bytes)); }
  catch (error) {
    if (error instanceof TablEditError) throw error;
    throw new TablEditError('The TablEdit file could not be read.', error);
  }
}

function read(r: Reader): TefDocument {
  const report = new ImportReport();
  if (r.bytes.length < OFFSET.tbed + 4) throw new TablEditError('This is not a TablEdit file (too short).');
  const tbed = r.u32At(OFFSET.tbed);
  if (tbed === TBED_REVERSED) throw new TablEditError('This TablEdit file uses the byte-swapped (big-endian) layout, which is not supported.');
  if (tbed !== TBED) throw new TablEditError('This is not a TablEdit file (missing "tbed" marker).');
  if (r.bytes.length < HEADER_BYTES) throw new TablEditError('The TablEdit file is truncated or damaged (header incomplete).');
  const tempo = r.u16At(6);
  if (r.u32At(16) !== 0) throw new TablEditError('Protected TablEdit files (with a security code) cannot be opened.');
  if (r.u16At(OFFSET.oldNum) !== 4 || (r.u16At(OFFSET.oldNum + 2) >> 8) !== 10)
    throw new TablEditError('This TablEdit file version is not supported (only TablEdit 3.x files are).');

  const pointer = (offset: number) => {
    const p = r.u32At(offset);
    if (p >= r.bytes.length) throw new TablEditError('The TablEdit file is truncated or damaged (a pointer lies outside the file).');
    return p;
  };
  const title = r.textAt(pointer(OFFSET.title)), subtitle = r.textAt(pointer(OFFSET.subtitle)), copyright = r.textAt(pointer(OFFSET.copyright));
  report.bump('comment, notes and link fields', [OFFSET.comment, OFFSET.notes, OFFSET.link].filter(o => r.textAt(pointer(o)) !== '').length);

  const measuresAt = pointer(OFFSET.measures), instrumentsAt = pointer(OFFSET.instruments), contentsAt = pointer(OFFSET.contents);
  if (!measuresAt || !instrumentsAt || !contentsAt) throw new TablEditError('The TablEdit file has no music (a required table is missing).');

  const mt = readTable(r, measuresAt, 'measures', TEF_LIMITS.measures, MEASURE_BYTES, 8);
  if (!mt.count) throw new TablEditError('The TablEdit file contains no measures.');
  const measures: TefMeasure[] = [];
  for (let i = 0; i < mt.count; i++) {
    r.seek(mt.start + i * mt.stride);
    const flag = r.u8(); r.skip(1); const key = r.i8(); r.skip(1); const denominator = r.u8(), numerator = r.u8();
    measures.push({ pickup: (flag & 0x08) !== 0, key, numerator, denominator });
  }

  const it = readTable(r, instrumentsAt, 'instruments', TEF_LIMITS.instruments, INSTRUMENT_BYTES, 4);
  if (!it.count) throw new TablEditError('The TablEdit file contains no instruments.');
  const instruments: TefInstrument[] = [];
  let totalStrings = 0;
  for (let i = 0; i < it.count; i++) {
    r.seek(it.start + i * it.stride);
    const strings = r.u16(); r.skip(6);
    const midi = r.u8(); r.skip(3); const capo = r.u16(); r.skip(6);
    if (strings < 1 || strings > TEF_LIMITS.stringsPerInstrument) throw new TablEditError(`The TablEdit file has an instrument with ${strings} strings, which is not supported.`);
    const stored = Array.from({ length: 12 }, () => r.u8());
    const nameBytes = Array.from({ length: 36 }, () => r.u8());
    const zero = nameBytes.indexOf(0), name = String.fromCharCode(...nameBytes.slice(0, zero < 0 ? 36 : zero).filter(c => c >= 0x20 && c <= 0x7e)).trim();
    // The file lists the lowest string first; string 1 (top line) is the last stored value. Pitch is 96 minus the value.
    const tuning = Array.from({ length: strings }, (_, k) => 96 - stored[strings - 1 - k]);
    if (tuning.some(p => p < 0 || p > 127)) throw new TablEditError('The TablEdit file contains an invalid tuning.');
    instruments.push({ strings, midi, capo, name, tuning, firstString: totalStrings });
    totalStrings += strings;
  }

  const readingList: [number, number][] = [];
  const listAt = pointer(OFFSET.readingList);
  if (listAt) {
    const rt = readTable(r, listAt, 'reading list entries', TEF_LIMITS.readingListItems, 4, 4);
    for (let i = 0; i < rt.count; i++) { r.seek(rt.start + i * rt.stride); readingList.push([r.u16(), r.u16()]); }
  }

  // Contents: entries of a 32 bit position/string word and eight bytes, ending at an all-ones word.
  r.seek(contentsAt);
  const events: TefEvent[] = [];
  for (;;) {
    const word = r.u32();
    if (word === END_OF_CONTENTS) break;
    r.need(8);
    const b = r.bytes.subarray(r.pos, r.pos + 8); r.pos += 8;
    if (events.length >= TEF_LIMITS.events) throw tooLarge();
    const slot = word >>> 3, position = Math.floor(slot / totalStrings), string = slot % totalStrings;
    const marker = b[0] & 0x3f;
    if (marker === 0x39) { report.bump('text markers'); continue; }
    if (marker === 0 || marker > 0x33) { report.bump('events of an unrecognised kind'); continue; }
    if (b[6] & 0x1f) report.bump('fingerings');
    const voiceBits = (b[2] >> 4) & 3;
    let grace: TefEvent['grace'] = null;
    if (b[0] & 0x40) {
      grace = { fret: b[3] & 0x1f };
      if (b[3] >> 5) report.bump('grace-note effects');
    }
    events.push({ position, string, kind: marker === 0x33 ? 'rest' : 'note', fret: marker - 1, code: b[1] & 0x1f, tie: (b[1] >> 5) === 7, voice: voiceBits === 3 ? 1 : 0, grace });
  }
  return { tempo, title, subtitle, copyright, measures, instruments, readingList, events, totalStrings, report };
}
