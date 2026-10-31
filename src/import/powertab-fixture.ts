// Synthetic Power Tab writer used only by tests. It encodes the layout the importer
// assumes, so it proves internal consistency, not agreement with real Power Tab files.

class W {
  out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u16(v: number) { this.u8(v); this.u8(v >> 8); return this; }
  u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); return this; }
  str(s: string) {
    const bytes = [...s].map(c => c.charCodeAt(0) & 0xff);
    if (bytes.length < 0xff) this.u8(bytes.length); else { this.u8(0xff); this.u16(bytes.length); }
    this.out.push(...bytes); return this;
  }
  zeros(n: number) { for (let i = 0; i < n; i++) this.u8(0); return this; }
  /** Vector with a new-class header first and back-reference tags after, like an MFC archive. */
  vec<T>(items: T[], write: (item: T) => void) {
    this.u16(items.length);
    items.forEach((item, i) => { if (i === 0) { this.u16(0xffff).u16(1).u16(3); this.out.push(0x41, 0x42, 0x43); } else this.u16(0x8001); write(item); });
    return this;
  }
  small(values: number[], size: 1 | 2 | 4) {
    this.u8(values.length);
    for (const v of values) size === 1 ? this.u8(v) : size === 2 ? this.u16(v) : this.u32(v);
    return this;
  }
}

export interface FxNote { string: number; fret: number; simple?: number; symbols?: number[] }
export interface FxPos { position: number; duration?: number; flags?: number; beaming?: number; notes?: FxNote[]; symbols?: number[] }
export interface FxBar { position: number; type?: number; repeat?: number; key?: number; time?: number; letter?: number; desc?: string }
export interface FxStaff { strings?: number; clef?: number; voices: [FxPos[], FxPos[]?] }
export interface FxSystem { start?: FxBar; bars?: FxBar[]; endType?: number; endRepeat?: number; staves: FxStaff[]; directions?: number; chordTexts?: number; slashes?: number }
export interface FxScore {
  guitars?: { description?: string; preset?: number; capo?: number; tuning: number[] }[];
  tempos?: { system: number; position: number; data: number }[];
  systems: FxSystem[]; chordDiagrams?: number; floatingTexts?: number; dynamics?: number; alternateEndings?: number; guitarIns?: number;
}
export interface FxFile { version?: 3 | 4; title?: string; artist?: string; guitar: FxScore; bass?: FxScore | null }

export const timeSig = (n: number, d: number, shown = true) => ((n - 1) << 27 | Math.log2(d) << 24 | (shown ? 0x100000 : 0)) >>> 0;
export const tempoData = (bpm: number, beatType = 2, type = 1) => ((type << 27) | (beatType << 23) | bpm) >>> 0;

function bar(w: W, b: FxBar) {
  w.u8(b.position).u8(((b.type ?? 0) << 5) | (b.repeat ?? 0)).u8(b.key ?? 0).u32(b.time ?? 0).u8(0).u8(b.letter ?? 0xff).str(b.desc ?? '');
}

function score(w: W, s: FxScore) {
  w.vec(s.guitars ?? [], g => {
    w.u8(0).str(g.description ?? '').u8(g.preset ?? 25).zeros(6).u8(g.capo ?? 0);
    w.str('tuning').u8(0).small(g.tuning, 1);
  });
  w.vec(Array.from({ length: s.chordDiagrams ?? 0 }), () => { w.u16(0).u8(0).u16(0).u8(0).u8(0).small([0, 1, 2], 1); });
  w.vec(Array.from({ length: s.floatingTexts ?? 0 }), () => { w.str('text').zeros(16).u8(0).str('Arial').zeros(8).zeros(3).zeros(4); });
  w.vec(Array.from({ length: s.guitarIns ?? 0 }), () => { w.u16(0).u8(0).u8(0).u16(0); });
  w.vec(s.tempos ?? [], t => { w.u16(t.system).u8(t.position).u32(t.data).str('tempo'); });
  w.vec(Array.from({ length: s.dynamics ?? 0 }), () => { w.u16(0).u8(0).u8(0).u16(0); });
  w.vec(Array.from({ length: s.alternateEndings ?? 0 }), () => { w.u16(0).u8(0).u32(0); });
  w.vec(s.systems, sys => {
    w.zeros(16).u8(((sys.endType ?? 0) << 5) | (sys.endRepeat ?? 0)).zeros(4);
    bar(w, sys.start ?? { position: 0 });
    w.vec(Array.from({ length: sys.directions ?? 0 }), () => { w.u8(0).small([1], 2); });
    w.vec(Array.from({ length: sys.chordTexts ?? 0 }), () => { w.u8(0).u16(0).u8(0).u16(0).u8(0); });
    w.vec(Array.from({ length: sys.slashes ?? 0 }), () => { w.u8(0).u8(0).u32(0); });
    w.vec(sys.staves, st => {
      w.u8(((st.clef ?? 0) << 4) | (st.strings ?? 6)).zeros(4);
      for (const voice of [st.voices[0], st.voices[1] ?? []]) {
        w.vec(voice, p => {
          w.u8(p.position).u8(p.beaming ?? 0).u32((((p.duration ?? 4) << 24) | (p.flags ?? 0)) >>> 0).small(p.symbols ?? [], 4);
          w.vec(p.notes ?? [], n => { w.u8((n.string << 5) | n.fret).u16(n.simple ?? 0).small(n.symbols ?? [], 4); });
        });
      }
    });
    w.vec(sys.bars ?? [], b => bar(w, b));
  });
}

export function buildPtb(f: FxFile): Uint8Array {
  const w = new W();
  w.out.push(0x70, 0x74, 0x61, 0x62); w.u16(f.version ?? 4);
  if ((f.version ?? 4) === 4) {
    w.u8(0).u8(0).str(f.title ?? 'Synthetic').str(f.artist ?? 'Fixture').u8(3).u8(0).str('Composer').str('Lyricist');
    for (let i = 0; i < 7; i++) w.str('');
  } else {
    w.str(f.title ?? 'Synthetic').str(f.artist ?? 'Fixture').u8(0).str('').u8(0).str('').str('').str('').u16(2000).u8(0).str('').str('');
  }
  score(w, f.guitar);
  score(w, f.bass ?? { systems: [] });
  return Uint8Array.from(w.out);
}

/** A two-measure 4/4 riff: C major triad quarter notes then an eighth-note run with a tie. */
export function basicFile(extra: Partial<FxFile> = {}): FxFile {
  return {
    guitar: {
      guitars: [{ description: 'Lead', preset: 29, tuning: [64, 59, 55, 50, 45, 40] }],
      tempos: [{ system: 0, position: 1, data: tempoData(100) }],
      systems: [{
        start: { position: 0, time: timeSig(4, 4), key: 0x10 | 1 },
        bars: [{ position: 9, type: 4, repeat: 3 }],
        endType: 1,
        staves: [{ voices: [[
          { position: 1, duration: 4, notes: [{ string: 1, fret: 1 }, { string: 4, fret: 2 }] },
          { position: 3, duration: 4, notes: [{ string: 2, fret: 0 }] },
          { position: 5, duration: 4, flags: 0x04 },
          { position: 7, duration: 4, notes: [{ string: 1, fret: 3, simple: 0x08 }] },
          { position: 10, duration: 8, flags: 0x01, notes: [{ string: 1, fret: 3, simple: 0x01 }] },
          { position: 12, duration: 8, notes: [{ string: 5, fret: 3 }] },
        ]] }],
      }],
    },
    ...extra,
  };
}
