// Synthetic TablEdit writer used only by tests. No real .tef file was available: this encodes the layout the importer
// assumes (see docs/validation/2026-10-31-gp8-tablature-tef-import.md), so it proves internal consistency, not
// agreement with files produced by TablEdit.

export interface TefFxInstrument { strings?: number; midi?: number; capo?: number; name?: string; /** MIDI pitches, highest string first. */ tuning?: number[] }
export interface TefFxMeasure { flag?: number; key?: number; num?: number; den?: number }
export interface TefFxEvent {
  position: number; string: number;
  kind?: 'note' | 'rest' | 'text' | 'raw';
  fret?: number; /** raw duration code, default 6 (quarter) */ duration?: number; tie?: boolean; voice?: number;
  grace?: { fret: number; effect?: number }; fingering?: number; marker?: number; textIndex?: number;
}
export interface TefFx {
  tempo?: number; title?: string; subtitle?: string; comment?: string; notes?: string; link?: string; copyright?: string;
  securityCode?: number; formatHigh?: number; oldNum?: number; reversedTbed?: boolean; noTbed?: boolean;
  instruments?: TefFxInstrument[]; measures?: TefFxMeasure[]; events?: TefFxEvent[]; readingList?: [number, number][]; texts?: string[];
  noSentinel?: boolean; measureStructSize?: number;
}

const HEADER = 0xd0;
export const TEF_OFFSETS = { tbed: 0x38, contents: 0x3c, title: 0x40, subtitle: 0x44, comment: 0x48, notes: 0x4c, texts: 0x54, measures: 0x5c, instruments: 0x60, readingList: 0x80, link: 0x84, copyright: 0x8c, oldNum: 0xca } as const;

/** Duration code for a plain / dotted / triplet note of base type 0 (whole) to 6 (64th). */
export const durationCode = (type: number, style: 'plain' | 'dot' | 'triplet' = 'plain') => style === 'dot' ? type * 3 - 2 : style === 'triplet' ? type * 3 + 2 : type * 3;

class W {
  out: number[] = [];
  get length() { return this.out.length; }
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16(Math.floor(v / 65536) & 0xffff); }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  text(s: string) { const bytes = [...s].map(c => c.charCodeAt(0) & 0xff); this.u16(bytes.length + 1); this.out.push(...bytes, 0); return this; }
}

/** File tuning values (96 - MIDI), stored lowest string first, from highest-first MIDI pitches. */
export const tefTuning = (highFirst: number[]) => [...highFirst].reverse().map(m => 96 - m);

export function buildTef(f: TefFx = {}): Uint8Array {
  const instruments = f.instruments ?? [{}];
  const measures = f.measures ?? [{ num: 4, den: 4 }, { num: 4, den: 4 }];
  const body = new W();
  const at = (w: W) => HEADER + w.length;
  const head = new Uint8Array(HEADER);
  const hv = new DataView(head.buffer);
  const ptr = (offset: number, value: number) => hv.setUint32(offset, value, true);
  hv.setUint16(2, 3, true); hv.setUint16(4, 0, true); hv.setUint16(6, f.tempo ?? 100, true);
  hv.setUint32(16, f.securityCode ?? 0, true);
  if (!f.noTbed) { if (f.reversedTbed) head.set([0x64, 0x65, 0x62, 0x74], TEF_OFFSETS.tbed); else head.set([0x74, 0x62, 0x65, 0x64], TEF_OFFSETS.tbed); }
  hv.setUint16(TEF_OFFSETS.oldNum, f.oldNum ?? 4, true); hv.setUint16(TEF_OFFSETS.oldNum + 2, (f.formatHigh ?? 10) << 8, true);
  const textAt = (key: keyof typeof TEF_OFFSETS, value: string | undefined) => { if (value) { ptr(TEF_OFFSETS[key], at(body)); body.text(value); } };
  textAt('title', f.title ?? 'Synthetic'); textAt('subtitle', f.subtitle); textAt('comment', f.comment); textAt('notes', f.notes); textAt('link', f.link); textAt('copyright', f.copyright);
  ptr(TEF_OFFSETS.measures, at(body));
  body.u16(f.measureStructSize ?? 8).u16(measures.length).u32(0);
  for (const m of measures) body.u8(m.flag ?? 0).u8(0).u8((m.key ?? 0) & 0xff).u8(0).u8(m.den ?? 4).u8(m.num ?? 4).u16(0);
  ptr(TEF_OFFSETS.instruments, at(body));
  body.u16(68).u16(instruments.length);
  for (const ins of instruments) {
    const n = ins.strings ?? 6;
    const tuning = ins.tuning ? tefTuning(ins.tuning) : tefTuning([64, 59, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10].slice(0, n));
    body.u16(n).u16(1).u16(0).u16(0).u8(ins.midi ?? 25).u8(0).u8(0).u8(0).u16(ins.capo ?? 0).u8(0).u8(0).u16(0).u16(0);
    for (let i = 0; i < 12; i++) body.u8(tuning[i] ?? 0);
    const name = [...(ins.name ?? 'Guitar')].map(c => c.charCodeAt(0) & 0x7f).slice(0, 35);
    body.out.push(...name); body.zeros(36 - name.length);
  }
  if (f.readingList) {
    ptr(TEF_OFFSETS.readingList, at(body));
    body.u16(8).u16(f.readingList.length);
    for (const [a, b] of f.readingList) body.u16(a).u16(b).u32(0);
  }
  if (f.texts) { ptr(TEF_OFFSETS.texts, at(body)); body.u16(f.texts.length); for (const t of f.texts) body.text(t); }
  const total = instruments.reduce((sum, i) => sum + (i.strings ?? 6), 0);
  ptr(TEF_OFFSETS.contents, at(body));
  for (const e of f.events ?? []) {
    const kind = e.kind ?? 'note';
    body.u32((e.position * total + (e.string - 1)) * 8);
    let marker = e.marker ?? (kind === 'rest' ? 0x33 : kind === 'text' ? 0x39 : (e.fret ?? 0) + 1);
    if (e.grace) marker |= 0x40;
    body.u8(marker).u8(((e.tie ? 7 : 0) << 5) | ((e.duration ?? 6) & 0x1f)).u8(((e.voice ?? 0) << 4) | 0);
    if (kind === 'text') { body.out[body.out.length - 2] = (e.textIndex ?? 0) & 0xff; body.out[body.out.length - 1] = (e.textIndex ?? 0) >> 8; }
    body.u8(e.grace ? ((e.grace.effect ?? 0) << 5) | e.grace.fret : 0).u8(0).u8(0).u8(e.fingering ?? 0).u8(0);
  }
  if (!f.noSentinel) body.u32(0xffffffff);
  const out = new Uint8Array(HEADER + body.length);
  out.set(head); out.set(body.out, HEADER);
  return out;
}

/** Two 4/4 measures of a six-string guitar: a chord, a rest, a tied pair and an eighth pair. Positions are in 64ths of a whole note. */
export function basicTef(extra: TefFx = {}): TefFx {
  return {
    tempo: 100, title: 'Synthetic', copyright: '(c) fixture',
    events: [
      { position: 0, string: 1, fret: 1 }, { position: 0, string: 4, fret: 2 },
      { position: 16, string: 2, fret: 0 },
      { position: 32, kind: 'rest', string: 1 },
      { position: 48, string: 1, fret: 3, duration: 6 },
      { position: 64, string: 1, fret: 3, tie: true, duration: 3 },
      { position: 96, string: 6, fret: 3, duration: 9 },
      { position: 104, string: 5, fret: 3, duration: 9 },
    ],
    ...extra,
  };
}
