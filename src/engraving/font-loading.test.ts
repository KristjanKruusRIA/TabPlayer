// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {EngravingFonts} from './fonts';

type Made={family:string;source:string;descriptors:{weight:string;style:string};load:ReturnType<typeof vi.fn>};
const made:Made[]=[],added:Made[]=[];
let failFile='';
beforeEach(()=>{
  vi.resetModules();made.length=0;added.length=0;failFile='';
  vi.stubGlobal('FontFace',class {
    family:string;source:string;descriptors:{weight:string;style:string};
    load=vi.fn(():Promise<unknown>=>failFile&&this.source.includes(failFile)?Promise.reject(new Error('load failed')):Promise.resolve(this));
    constructor(family:string,source:string,descriptors:{weight:string;style:string}){this.family=family;this.source=source;this.descriptors=descriptors;made.push(this as unknown as Made);}
  });
  Object.defineProperty(document,'fonts',{configurable:true,value:{add:(face:Made)=>added.push(face)}});
});
afterEach(()=>vi.unstubAllGlobals());
const load=()=>import('./font-loading');
const files=(faces:Array<{file:string}>)=>faces.map(face=>face.file).sort();
const lyricsSerif:EngravingFonts={roles:{lyrics:{font:'notoSerif'}}};

it('needed_faces_only_for_chosen_roles',async()=>{
  const {neededFaces}=await load();
  expect(neededFaces(undefined)).toEqual([]);expect(neededFaces({})).toEqual([]);expect(neededFaces({music:'petaluma'})).toEqual([]);
  // A size-only role needs no face.
  expect(neededFaces({roles:{lyrics:{size:1.5}}})).toEqual([]);
  // Lyrics are italic by default, so Serif asks for its Italic face; Noto Sans Regular always comes along (P17), and so does
  // the font's own upright regular face, which alphaTab's width table is measured from.
  expect(files(neededFaces(lyricsSerif))).toEqual(['NotoSans-Regular.ttf','NotoSerif-Italic.ttf','NotoSerif-Regular.ttf']);
  // Explicit flags choose the face; false is a choice.
  expect(files(neededFaces({roles:{lyrics:{font:'notoSerif',italic:false,bold:true}}}))).toEqual(['NotoSans-Regular.ttf','NotoSerif-Bold.ttf','NotoSerif-Regular.ttf']);
  // Markers are bold by default and Mono has Bold; staff text is italic by default and Mono has no italic, so it falls to Regular.
  expect(files(neededFaces({roles:{markers:{font:'notoSansMono'},staffText:{font:'notoSansMono'}}}))).toEqual(['NotoSans-Regular.ttf','NotoSansMono-Bold.ttf','NotoSansMono-Regular.ttf']);
  // A role asking for several default styles needs each once: tab numbers are regular only, chord names italic (and regular for fretboard numbers).
  const chords=files(neededFaces({roles:{chordNames:{font:'notoSansMono'}}}));
  expect(chords).toEqual(['NotoSans-Regular.ttf','NotoSansMono-Regular.ttf']);
  expect(files(neededFaces({roles:{pageHeader:{font:'notoSerif',bold:true,italic:true}}}))).toEqual(['NotoSans-Regular.ttf','NotoSerif-BoldItalic.ttf','NotoSerif-Regular.ttf']);
  expect(files(neededFaces({roles:{pageFooter:{font:'notoSans'}}}))).toEqual(['NotoSans-Regular.ttf']);
  // Never a face the font does not have.
  const mono=neededFaces({roles:{lyrics:{font:'notoSansMono',italic:true}}});
  expect(files(mono).every(file=>file!=='NotoSansMono-Italic.ttf')).toBe(true);
});

it('loads_each_needed_face_once_under_its_alias_and_adds_noto_sans',async()=>{
  const {loadRoleFaces,roleFacesPending}=await load();
  expect(roleFacesPending(undefined)).toBe(false);expect(roleFacesPending(lyricsSerif)).toBe(true);
  const result=await loadRoleFaces(lyricsSerif);await loadRoleFaces(lyricsSerif);
  expect(result).toEqual({failed:[]});
  expect(made.map(face=>[face.family,face.source,face.descriptors.weight,face.descriptors.style]).sort()).toEqual([
    ['Noto Sans','url(/export-fonts/NotoSans-Regular.ttf)','400','normal'],
    ['TabPlayer Serif','url(/export-fonts/NotoSerif-Italic.ttf)','400','italic'],
    ['TabPlayer Serif','url(/export-fonts/NotoSerif-Regular.ttf)','400','normal'],
  ]);
  expect(added).toHaveLength(3);expect(roleFacesPending(lyricsSerif)).toBe(false);
  // The same file under a second alias is a separate registration.
  await loadRoleFaces({roles:{lyrics:{font:'notoSans',italic:false}}});
  expect(made.map(face=>face.family).sort()).toEqual(['Noto Sans','TabPlayer Sans','TabPlayer Serif','TabPlayer Serif']);
});

it('every_alias_gets_its_regular_upright_face',async()=>{
  const {neededFaces,loadRoleFaces}=await load();
  // alphaTab builds one width table per family from the plain `11px <alias>` face, so an italic- or bold-only role must still register Regular.
  for(const [font,regular,styled] of [['notoSerif','NotoSerif-Regular.ttf','NotoSerif-BoldItalic.ttf'],['notoSans','NotoSans-Regular.ttf','NotoSans-BoldItalic.ttf'],['notoSansMono','NotoSansMono-Regular.ttf','NotoSansMono-Bold.ttf']] as const){
    const chosen:EngravingFonts={roles:{lyrics:{font,bold:true,italic:font!=='notoSansMono'}}};
    expect(files(neededFaces(chosen))).toContain(regular);expect(files(neededFaces(chosen))).toContain(styled);
  }
  made.length=0;
  await loadRoleFaces({roles:{lyrics:{font:'notoSerif',bold:true,italic:true}}});
  const alias=made.filter(face=>face.family==='TabPlayer Serif').map(face=>[face.source,face.descriptors.weight,face.descriptors.style]).sort();
  expect(alias).toEqual([['url(/export-fonts/NotoSerif-BoldItalic.ttf)','700','italic'],['url(/export-fonts/NotoSerif-Regular.ttf)','400','normal']]);
});

it('bold_faces_register_with_weight_700',async()=>{
  const {loadRoleFaces}=await load();
  await loadRoleFaces({roles:{markers:{font:'notoSerif',bold:true,italic:true}}});
  const bold=made.find(face=>face.family==='TabPlayer Serif'&&face.source.includes('BoldItalic'))!;
  expect([bold.source,bold.descriptors.weight,bold.descriptors.style]).toEqual(['url(/export-fonts/NotoSerif-BoldItalic.ttf)','700','italic']);
});

it('load_failure_reported_and_retried',async()=>{
  const {loadRoleFaces,roleFacesPending}=await load();
  failFile='NotoSerif-Italic';
  const first=await loadRoleFaces(lyricsSerif);
  expect(first.failed).toEqual(['NotoSerif-Italic.ttf']);
  // The face that loaded is added; the failed one is not, and nothing throws.
  expect(added.map(face=>face.family).sort()).toEqual(['Noto Sans','TabPlayer Serif']);
  expect(roleFacesPending(lyricsSerif)).toBe(true);
  const before=made.length;failFile='';
  const second=await loadRoleFaces(lyricsSerif);
  expect(second).toEqual({failed:[]});
  // Only the failed face is constructed again; the loaded one is memoized.
  expect(made.length-before).toBe(1);expect(made.at(-1)!.source).toContain('NotoSerif-Italic.ttf');
  expect(roleFacesPending(lyricsSerif)).toBe(false);
});

it('concurrent_loads_share_one_face',async()=>{
  const {loadRoleFaces}=await load();
  await Promise.all([loadRoleFaces(lyricsSerif),loadRoleFaces(lyricsSerif)]);
  expect(made).toHaveLength(3);expect(added).toHaveLength(3);
});

it('resolves_without_loading_where_FontFace_is_missing',async()=>{
  vi.stubGlobal('FontFace',undefined);
  const {loadRoleFaces}=await load();
  await expect(loadRoleFaces(lyricsSerif)).resolves.toEqual({failed:[]});
  expect(made).toHaveLength(0);
});

it('loading_nothing_when_no_role_has_a_font',async()=>{
  const {loadRoleFaces}=await load();
  await expect(loadRoleFaces(undefined)).resolves.toEqual({failed:[]});
  expect(made).toHaveLength(0);
});
