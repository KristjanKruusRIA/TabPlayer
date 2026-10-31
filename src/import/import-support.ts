// Code shared by the untrusted-file importers (Power Tab, TablEdit): a bounds-checked byte reader, the file size
// limit, and the dropped-content report that becomes the notice shown after an import.

/** Largest file either importer reads (Rust intake enforces the same number by signature). */
export const IMPORT_FILE_BYTES = 16 * 1024 * 1024;

/** Reads little-endian values from untrusted bytes. Every read is bounds-checked; failures use the importer's own error type. */
export class ByteReader {
  pos = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, private readonly label: string, private readonly fail: (message: string) => Error) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() { return this.bytes.length - this.pos; }
  error(message: string): Error { return this.fail(message); }
  need(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > this.remaining) throw this.fail(`The ${this.label} file is truncated or damaged (unexpected end of data).`);
  }
  u8() { this.need(1); return this.bytes[this.pos++]; }
  i8() { this.need(1); return this.view.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.need(n); this.pos += n; }
  u16At(at: number) { this.seek(at); return this.u16(); }
  seek(at: number) {
    if (!Number.isInteger(at) || at < 0 || at > this.bytes.length) throw this.fail(`The ${this.label} file is truncated or damaged (a pointer lies outside the file).`);
    this.pos = at;
  }
}

/** Counts of content that was not imported, plus a bounded list of warnings. Everything is merged by label, never discarded. */
export class ImportReport {
  dropped: Record<string, number> = {};
  private warnings: string[] = [];
  private extraWarnings = 0;
  constructor(private readonly maxWarnings = 12) {}
  bump(key: string, by = 1) { if (by > 0) this.dropped[key] = (this.dropped[key] ?? 0) + by; }
  merge(counts: Record<string, number>) { for (const [key, by] of Object.entries(counts)) this.bump(key, by); }
  warn(message: string) {
    if (this.warnings.includes(message)) return;
    if (this.warnings.length < this.maxWarnings) this.warnings.push(message); else this.extraWarnings++;
  }
  labels() { return droppedLabels(this.dropped); }
  warningText(): string[] { return this.extraWarnings ? [...this.warnings, `${this.extraWarnings} further warning${this.extraWarnings === 1 ? '' : 's'} not shown.`] : [...this.warnings]; }
}

export function droppedLabels(dropped: Record<string, number>) {
  return Object.entries(dropped).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${v} ${k}`);
}
