// Power Tab 1.5/1.7 (.ptb) reader.
//
// Implemented from the public format description (field order and widths as
// documented by the Power Tab Editor project's published reader behaviour);
// no third-party source is copied. See docs/validation/2026-10-31-gp8-powertab-import.md.
//
// The input is untrusted: every read is bounds-checked, every count is capped and
// checked against the bytes that remain, nothing recurses, and every failure is a
// PowerTabError with a message suitable for the user.

export class PowerTabError extends Error {
  constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = 'PowerTabError'; }
}

export const PTB_LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  guitars: 32,
  systems: 4096,
  stavesPerSystem: 8,
  barlinesPerSystem: 256,
  positionsPerVoice: 1024,
  notesPerPosition: 16,
  tuningStrings: 12,
  totalMeasures: 20000,
  totalPositions: 400000,
  stringBytes: 65535,
  objectsPerVector: 100000,
} as const;

export interface PtbNote { string: number; fret: number; simple: number; symbols: number[] }
export interface PtbPosition { position: number; beaming: number; data: number; symbols: number[]; notes: PtbNote[] }
export interface PtbBarline {
  position: number; type: number; repeat: number;
  keyData: number; timeData: number; pulses: number; letter: number; description: string;
}
export interface PtbStaff { clef: number; strings: number; voices: PtbPosition[][] }
export interface PtbSystem { startBar: PtbBarline; barlines: PtbBarline[]; endType: number; endRepeat: number; staves: PtbStaff[] }
export interface PtbGuitar { number: number; description: string; preset: number; capo: number; tuning: number[] }
export interface PtbTempo { system: number; position: number; data: number; description: string }
export interface PtbScore { guitars: PtbGuitar[]; tempos: PtbTempo[]; systems: PtbSystem[] }
export interface PtbDocument {
  version: number; title: string; artist: string;
  guitar: PtbScore; bass: PtbScore | null;
  /** Reason the bass score was skipped, when it could not be read. */
  bassError: string | null;
  /** Counts of recognised-but-unimported object kinds read from the file. */
  dropped: Record<string, number>;
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array, readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) {}
  get remaining() { return this.bytes.length - this.pos; }
  private need(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > this.remaining) throw new PowerTabError('The Power Tab file is truncated or damaged (unexpected end of data).');
  }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  i8() { this.need(1); return this.view.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.need(n); this.pos += n; }
  string() {
    let length = this.u8();
    if (length === 0xff) { length = this.u16(); if (length === 0xffff) length = this.u32(); }
    if (length > PTB_LIMITS.stringBytes) throw new PowerTabError('The Power Tab file contains an oversized text field.');
    this.need(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      const c = this.bytes[this.pos + i];
      out += c < 32 && c !== 9 ? ' ' : String.fromCharCode(c);
    }
    this.pos += length;
    return out.trim();
  }
  count() {
    const n = this.u16();
    return n === 0xffff ? this.u32() : n;
  }
  /** Reads (and skips) the per-element class header used by MFC-style archives. */
  classHeader() {
    const tag = this.u16();
    if (tag === 0x7fff) { this.u32(); return; }
    if (tag === 0xffff) {
      this.u16(); // schema
      const nameLength = this.u16();
      if (nameLength > 256) throw new PowerTabError('The Power Tab file has an invalid object header.');
      this.skip(nameLength);
    }
  }
  smallVector(elementBytes: number) {
    const n = this.u8();
    this.need(n * elementBytes);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(elementBytes === 1 ? this.u8() : elementBytes === 2 ? this.u16() : this.u32());
    }
    return out;
  }
}

function vector<T>(r: Reader, max: number, what: string, read: () => T): T[] {
  const n = r.count();
  if (n > max || n > PTB_LIMITS.objectsPerVector) throw new PowerTabError(`The Power Tab file declares too many ${what} (${n}).`);
  // Every element carries at least a two byte class header.
  if (n * 2 > r.remaining) throw new PowerTabError('The Power Tab file is truncated or damaged (more objects declared than data remains).');
  const out: T[] = [];
  for (let i = 0; i < n; i++) { r.classHeader(); out.push(read()); }
  return out;
}

function bump(dropped: Record<string, number>, key: string, by = 1) { if (by > 0) dropped[key] = (dropped[key] ?? 0) + by; }

function readBarline(r: Reader): PtbBarline {
  const position = r.u8(), data = r.u8(), keyData = r.u8(), timeData = r.u32(), pulses = r.u8();
  const letter = r.i8(), description = r.string();
  return { position, type: data >> 5, repeat: data & 0x1f, keyData, timeData, pulses, letter, description };
}

function readNote(r: Reader): PtbNote {
  const stringData = r.u8(), simple = r.u16(), symbols = r.smallVector(4);
  return { string: stringData >> 5, fret: stringData & 0x1f, simple, symbols };
}

function readPosition(r: Reader, budget: { positions: number }): PtbPosition {
  if (++budget.positions > PTB_LIMITS.totalPositions) throw new PowerTabError('The Power Tab file contains too many positions.');
  const position = r.u8(), beaming = r.u8(), data = r.u32(), symbols = r.smallVector(4);
  const notes = vector(r, PTB_LIMITS.notesPerPosition, 'notes', () => readNote(r));
  return { position, beaming, data, symbols, notes };
}

function readStaff(r: Reader, budget: { positions: number }): PtbStaff {
  const data = r.u8(); r.skip(4); // spacing bytes
  const voices = [0, 1].map(() => vector(r, PTB_LIMITS.positionsPerVoice, 'positions', () => readPosition(r, budget)));
  const strings = data & 0x0f;
  if (strings < 1 || strings > PTB_LIMITS.tuningStrings) throw new PowerTabError(`The Power Tab file has a staff with ${strings} strings, which is not supported.`);
  return { clef: data >> 4, strings, voices };
}

function readChordName(r: Reader) { r.u16(); r.u8(); r.u16(); r.u8(); }

function readScore(r: Reader, dropped: Record<string, number>): PtbScore {
  const budget = { positions: 0 };
  const guitars = vector(r, PTB_LIMITS.guitars, 'guitars', (): PtbGuitar => {
    const number = r.u8(), description = r.string();
    const preset = r.u8(); r.skip(6); // volume, pan, reverb, chorus, tremolo, phaser
    const capo = r.u8();
    r.string(); r.u8(); // tuning name, notation offset / flags
    const tuning = r.smallVector(1);
    if (tuning.length < 1 || tuning.length > PTB_LIMITS.tuningStrings || tuning.some(n => n > 127)) throw new PowerTabError('The Power Tab file contains an invalid tuning.');
    return { number, description, preset, capo, tuning };
  });
  bump(dropped, 'chord diagrams', vector(r, PTB_LIMITS.objectsPerVector, 'chord diagrams', () => { readChordName(r); r.u8(); r.smallVector(1); }).length);
  bump(dropped, 'text boxes', vector(r, PTB_LIMITS.objectsPerVector, 'text boxes', () => { r.string(); r.skip(16); r.u8(); r.string(); r.skip(8); r.skip(3); r.skip(4); }).length);
  bump(dropped, 'guitar changes', vector(r, PTB_LIMITS.objectsPerVector, 'guitar changes', () => { r.u16(); r.u8(); r.u8(); r.u16(); }).length);
  const tempos = vector(r, PTB_LIMITS.objectsPerVector, 'tempo markers', (): PtbTempo => ({ system: r.u16(), position: r.u8(), data: r.u32(), description: r.string() }));
  bump(dropped, 'dynamics', vector(r, PTB_LIMITS.objectsPerVector, 'dynamics', () => { r.u16(); r.u8(); r.u8(); r.u16(); }).length);
  bump(dropped, 'alternate endings', vector(r, PTB_LIMITS.objectsPerVector, 'alternate endings', () => { r.u16(); r.u8(); r.u32(); }).length);
  const systems = vector(r, PTB_LIMITS.systems, 'systems', (): PtbSystem => {
    r.skip(16); // layout rectangle
    const end = r.u8(); r.skip(4); // spacing bytes
    const startBar = readBarline(r);
    bump(dropped, 'directions', vector(r, PTB_LIMITS.objectsPerVector, 'directions', () => { r.u8(); r.smallVector(2); }).length);
    bump(dropped, 'chord names', vector(r, PTB_LIMITS.objectsPerVector, 'chord names', () => { r.u8(); readChordName(r); }).length);
    bump(dropped, 'rhythm slashes', vector(r, PTB_LIMITS.objectsPerVector, 'rhythm slashes', () => { r.u8(); r.u8(); r.u32(); }).length);
    const staves = vector(r, PTB_LIMITS.stavesPerSystem, 'staves', () => readStaff(r, budget));
    const barlines = vector(r, PTB_LIMITS.barlinesPerSystem, 'barlines', () => readBarline(r));
    return { startBar, barlines, endType: end >> 5, endRepeat: end & 0x1f, staves };
  });
  return { guitars, tempos, systems };
}

function readHeader(r: Reader) {
  if (r.remaining < 6 || r.u32() !== 0x62617470) throw new PowerTabError('This is not a Power Tab file (missing "ptab" signature).');
  const version = r.u16();
  if (version === 1 || version === 2) throw new PowerTabError('Power Tab 1.0 files are not supported. Open and re-save the file in Power Tab 1.7 first.');
  if (version !== 3 && version !== 4) throw new PowerTabError(`Power Tab file version ${version} is not supported (only 1.5 and 1.7 files are).`);
  if (version === 4) {
    if (r.u8() !== 0) throw new PowerTabError('Power Tab lesson files are not supported; only songs can be opened.');
    r.u8(); // content type
    const title = r.string(), artist = r.string();
    const release = r.u8();
    if (release === 0) { r.u8(); r.string(); r.u16(); r.u8(); }
    else if (release === 1) { r.string(); r.u8(); }
    else if (release === 2) { r.string(); r.u8(); r.u8(); r.u16(); }
    else if (release !== 3) throw new PowerTabError('The Power Tab file header is damaged (unknown release type).');
    if (r.u8() === 0) { r.string(); r.string(); }
    for (let i = 0; i < 7; i++) r.string(); // arranger, transcribers, copyright, lyrics, notes
    return { version, title, artist };
  }
  const title = r.string(), artist = r.string();
  r.u8(); r.string(); r.u8(); // released-on code, release title, live flag
  r.string(); r.string(); r.string(); // composer, lyricist, arranger
  r.u16(); r.u8(); // year, author type
  r.string(); r.string(); // copyright, lyrics
  return { version, title, artist };
}

export function isPowerTabBytes(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0x70 && bytes[1] === 0x74 && bytes[2] === 0x61 && bytes[3] === 0x62;
}

export function parsePowerTab(bytes: Uint8Array): PtbDocument {
  if (!(bytes instanceof Uint8Array)) throw new PowerTabError('Invalid Power Tab data.');
  if (bytes.length > PTB_LIMITS.fileBytes) throw new PowerTabError('The Power Tab file is larger than the 16 MiB import limit.');
  const r = new Reader(bytes), dropped: Record<string, number> = {};
  try {
    const { version, title, artist } = readHeader(r);
    const guitar = readScore(r, dropped);
    let bass: PtbScore | null = null, bassError: string | null = null;
    const mark = { ...dropped };
    try { bass = readScore(r, dropped); }
    catch (error) {
      if (!(error instanceof PowerTabError)) throw error;
      bassError = error.message;
      for (const key of Object.keys(dropped)) { if (key in mark) dropped[key] = mark[key]; else delete dropped[key]; }
    }
    return { version, title, artist, guitar, bass, bassError, dropped };
  } catch (error) {
    if (error instanceof PowerTabError) throw error;
    throw new PowerTabError('The Power Tab file could not be read.', error);
  }
}
