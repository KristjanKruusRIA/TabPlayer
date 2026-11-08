// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {EngravingSettings,Settings} from '@coderline/alphatab';
import type {SmuflMetadata} from '@coderline/alphatab';
import type {EngravingFonts} from './fonts';
import {canonicalGlyphName,mergeSmuflMetadata,neededGlyphs} from './smufl';
import {configureEngraving,defaultEngraving} from './projection';
import type {MusicFontData} from './font-loading';

type Made={family:string;source:string;descriptors:{weight:string;style:string};load:ReturnType<typeof vi.fn>};
const made:Made[]=[],added:Made[]=[];
let failFile='',fetched:string[]=[],metadataFails=false;
beforeEach(()=>{
  vi.resetModules();made.length=0;added.length=0;failFile='';fetched=[];metadataFails=false;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{fetched.push(url);if(metadataFails)return {ok:false,status:404,json:async()=>({})};return {ok:true,status:200,json:async()=>JSON.parse(readFileSync(`assets/fonts/${url.split('/').pop()}`,'utf8'))};}));
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

// ---- Task 6: music fonts ----
const box=(w:number)=>({bBoxNE:[w,1] as [number,number],bBoxSW:[0,0] as [number,number]});
const metadataOf=(boxes:Record<string,ReturnType<typeof box>>,anchors:Record<string,unknown>={}):SmuflMetadata=>({engravingDefaults:{staffLineThickness:0.1} as SmuflMetadata['engravingDefaults'],glyphBBoxes:boxes,glyphsWithAnchors:anchors as SmuflMetadata['glyphsWithAnchors']});

it('merge_fills_missing_bboxes_from_bravura_and_lists_them',()=>{
  const base=metadataOf({noteheadBlack:box(1.18),noteheadWhole:box(1.6),restQuarter:box(1)},{noteheadBlack:{stemUpSE:[1.18,0.168],cutOutNE:[0.5,0.5]}});
  const chosen=metadataOf({noteheadWhole:box(9),restQuarter:box(7),extra:box(3)},{noteheadWhole:{opticalCenter:[0.8,0]}});
  const {metadata,substituted}=mergeSmuflMetadata(chosen,base,['noteheadBlack','noteheadWhole','restQuarter']);
  expect(substituted).toEqual(['noteheadBlack']);
  // The missing glyph takes Bravura's box and anchors; present glyphs keep the chosen values; extra glyphs and defaults survive.
  expect(metadata.glyphBBoxes!.noteheadBlack).toEqual(box(1.18));
  expect(metadata.glyphsWithAnchors.noteheadBlack).toEqual({stemUpSE:[1.18,0.168],cutOutNE:[0.5,0.5]});
  expect(metadata.glyphBBoxes!.noteheadWhole).toEqual(box(9));expect(metadata.glyphBBoxes!.restQuarter).toEqual(box(7));expect(metadata.glyphBBoxes!.extra).toEqual(box(3));
  expect(metadata.glyphsWithAnchors.noteheadWhole).toEqual({opticalCenter:[0.8,0]});
  expect(metadata.engravingDefaults).toBe(chosen.engravingDefaults);
  // The inputs are not changed.
  expect(chosen.glyphBBoxes!.noteheadBlack).toBeUndefined();expect(base.glyphBBoxes!.noteheadBlack).toEqual(box(1.18));
  // A zero box is a glyph alphaTab skips, so it counts as missing and is replaced under the same key.
  const zero=mergeSmuflMetadata(metadataOf({noteheadBlack:{bBoxNE:[0,0],bBoxSW:[0,0]}}),base,['noteheadBlack']);
  expect(zero.substituted).toEqual(['noteheadBlack']);expect(Object.keys(zero.metadata.glyphBBoxes!)).toEqual(['noteheadBlack']);expect(zero.metadata.glyphBBoxes!.noteheadBlack).toEqual(box(1.18));
  // The default needed list is every glyph Bravura draws.
  const all=mergeSmuflMetadata(metadataOf({}),base);
  expect(all.substituted).toEqual(neededGlyphs(base));
});

it('merge_treats_tab_clef_aliases_as_present',()=>{
  // alphaTab's Bravura names the clefs FourStringTabClef; SMuFL fonts name them 4stringTabClef: one symbol, one key.
  const base=metadataOf({FourStringTabClef:box(2),SixStringTabClef:box(2)},{FourStringTabClef:{x:[1,1]}});
  const chosen=metadataOf({'4stringTabClef':box(5),'6stringTabClef':box(5)});
  const {metadata,substituted}=mergeSmuflMetadata(chosen,base);
  expect(substituted).toEqual([]);
  expect(Object.keys(metadata.glyphBBoxes!).sort()).toEqual(['4stringTabClef','6stringTabClef']);
  expect(metadata.glyphBBoxes!['4stringTabClef']).toEqual(box(5));
  // A font that lacks a clef gets Bravura's box under exactly one key and the clef is named by its SMuFL name.
  const lacking=mergeSmuflMetadata(metadataOf({'6stringTabClef':box(5)}),base);
  expect(lacking.substituted).toEqual([canonicalGlyphName('FourStringTabClef')]);
  expect(Object.keys(lacking.metadata.glyphBBoxes!).filter(key=>/^(4string|FourString)/.test(key))).toHaveLength(1);
  expect(lacking.metadata.glyphsWithAnchors.FourStringTabClef).toEqual({x:[1,1]});
});

it.each(['petaluma','leland'] as const)('real_%s_metadata_merges_to_the_reviewed_substitute_list',async id=>{
  const {loadMusicFont}=await load();
  const data=await loadMusicFont(id);
  const reviewed=JSON.parse(readFileSync('scripts/music-substitutes.json','utf8'));
  expect(data.substituted).toEqual(reviewed[id]);
  // Every glyph Bravura draws now has a box, so nothing can be blank.
  const have=new Set(neededGlyphs(data.metadata!));
  expect(neededGlyphs(EngravingSettings.bravuraMetadata).filter(name=>!have.has(name))).toEqual([]);
});

it('bravura_resolves_at_once_without_loading_anything',async()=>{
  const {loadMusicFont,loadedMusicFont,musicFontPending}=await load();
  expect(musicFontPending('bravura')).toBe(false);expect(loadedMusicFont('bravura')).toMatchObject({id:'bravura',metadata:null,substituted:[]});
  await expect(loadMusicFont('bravura')).resolves.toMatchObject({id:'bravura',families:['Bravura'],metadata:null,substituted:[]});
  expect(fetched).toEqual([]);expect(made).toHaveLength(0);
});

it('petaluma_loads_metadata_and_both_faces_once',async()=>{
  const {loadMusicFont,loadedMusicFont,musicFontPending}=await load();
  expect(musicFontPending('petaluma')).toBe(true);expect(loadedMusicFont('petaluma')).toBeNull();
  const [one,two]=await Promise.all([loadMusicFont('petaluma'),loadMusicFont('petaluma')]);
  expect(one).toBe(two);expect(await loadMusicFont('petaluma')).toBe(one);
  expect(fetched).toEqual(['/export-fonts/petaluma_metadata.json']);
  expect(made.map(face=>[face.family,face.source])).toEqual([['Petaluma','url(/export-fonts/Petaluma.otf)'],['TabPlayer Bravura','url(/export-fonts/Bravura.otf)']]);
  expect(added).toHaveLength(2);
  expect(one.id).toBe('petaluma');expect(one.families).toEqual(['Petaluma','TabPlayer Bravura']);
  expect(one.families.every(family=>!/\d/.test(family))).toBe(true);
  expect(musicFontPending('petaluma')).toBe(false);expect(loadedMusicFont('petaluma')).toBe(one);
  // Leland shares the Bravura alias face instead of registering it again.
  await loadMusicFont('leland');
  expect(made.filter(face=>face.family==='TabPlayer Bravura')).toHaveLength(1);expect(made.filter(face=>face.family==='Leland')).toHaveLength(1);
});

it('a_failed_music_load_rejects_and_the_next_call_retries',async()=>{
  const {loadMusicFont,musicFontPending}=await load();
  metadataFails=true;
  await expect(loadMusicFont('leland')).rejects.toThrow();
  expect(musicFontPending('leland')).toBe(true);
  metadataFails=false;failFile='Leland.otf';
  await expect(loadMusicFont('leland')).rejects.toThrow();
  failFile='';
  await expect(loadMusicFont('leland')).resolves.toMatchObject({id:'leland'});
});

const loadedPetaluma=async():Promise<MusicFontData>=>{const {loadMusicFont}=await load();return loadMusicFont('petaluma');};
const petalumaEngraving=()=>({...defaultEngraving(),fonts:{music:'petaluma' as const}});

it('configure_resets_to_bravura_defaults',async()=>{
  const petaluma=await loadedPetaluma(),settings=new Settings();
  configureEngraving(settings,petalumaEngraving(),petaluma);
  const withPetaluma=settings.display.resources.engravingSettings;
  expect(withPetaluma).not.toEqual(EngravingSettings.bravuraDefaults);
  expect(withPetaluma.musicFontSize).toBe(EngravingSettings.bravuraDefaults.musicFontSize);
  // Switching back leaves nothing of Petaluma behind, and the shared defaults are never the object that was changed.
  configureEngraving(settings,defaultEngraving());
  expect(settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);
  expect(settings.display.resources.engravingSettings).not.toBe(EngravingSettings.bravuraDefaults);
  expect(EngravingSettings.bravuraDefaults).toEqual(new Settings().display.resources.engravingSettings);
  // A Bravura document ignores whatever music data is passed.
  configureEngraving(settings,defaultEngraving(),petaluma);
  expect(settings.display.resources.engravingSettings).toEqual(EngravingSettings.bravuraDefaults);
});

it('configure_throws_without_loaded_music',async()=>{
  const petaluma=await loadedPetaluma(),{loadMusicFont}=await load(),leland=await loadMusicFont('leland');
  for(const music of [undefined,null,leland]){
    expect(()=>configureEngraving(new Settings(),petalumaEngraving(),music)).toThrow('Music font is not loaded.');
  }
  // Bravura data has no metadata to fill from, so it never stands in for another font.
  expect(()=>configureEngraving(new Settings(),petalumaEngraving(),{id:'bravura',families:['Bravura'],metadata:null,substituted:[]})).toThrow('Music font is not loaded.');
  expect(()=>configureEngraving(new Settings(),petalumaEngraving(),petaluma)).not.toThrow();
});
