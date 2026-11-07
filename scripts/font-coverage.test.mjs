import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EngravingSettings} from '@coderline/alphatab';
import {codePoints} from './font-cmap.mjs';
import {buildCoverage,buildSubstitutes,symbolCodePoints,coveragePath,substitutesPath,fontsDir,readCodePoints,readSources} from './font-coverage.mjs';
import {textFonts,musicFonts,fallbackFiles,covers,faceFor,hasFace} from '../src/engraving/font-catalog.ts';
import {neededGlyphs,canonicalGlyphName} from '../src/engraving/smufl.ts';

const root=new URL('../',import.meta.url);
const text=path=>readFileSync(new URL(path,root),'utf8');
const sources=readSources();
const estonianGerman=[...'ÄÖÜÕäöüõßẞŠšŽž„“”‘’–—…€°'].map(char=>char.codePointAt(0));
const sharp=0x266f,flat=0x266d;
const faces=Object.entries(textFonts).flatMap(([id,font])=>font.faces.map(face=>({id,...face})));
const points=new Map();
const pointsOf=file=>{if(!points.has(file))points.set(file,readCodePoints(file));return points.get(file)};

test('text_faces_cover_estonian_and_german',()=>{
  assert.equal(faces.length,10);
  for(const face of faces)for(const point of estonianGerman)assert.ok(pointsOf(face.file).has(point),`${face.file} lacks U+${point.toString(16)}`);
});

test('sharp_and_flat_covered_by_chain',()=>{
  const chain=[pointsOf('NotoSans-Regular.ttf'),pointsOf('NotoSansCJKjp-Regular.otf')];
  for(const face of faces)for(const point of [sharp,flat])assert.ok([pointsOf(face.file),...chain].some(set=>set.has(point)),`${face.file} chain lacks U+${point.toString(16)}`);
});

const bravuraMetadata=EngravingSettings.bravuraMetadata;
const needed=neededGlyphs(bravuraMetadata);
const substitutes=JSON.parse(text('scripts/music-substitutes.json'));
const symbols=symbolCodePoints();

test('needed_glyphs_have_one_code_point_each',()=>{
  assert.ok(needed.length>250);
  assert.equal(canonicalGlyphName('FourStringTabClef'),'4stringTabClef');
  assert.equal(needed.includes('FourStringTabClef'),false);
  assert.ok(needed.includes('4stringTabClef')&&needed.includes('6stringTabClef'));
  for(const name of needed)assert.equal(typeof symbols[name],'number',`${name} has no MusicFontSymbol code point`);
});

test('music_fonts_cover_alphatab_symbols_or_list_substitutes',()=>{
  assert.deepEqual(Object.keys(substitutes).sort(),['leland','petaluma']);
  const bravura=pointsOf(musicFonts.bravura.file);
  for(const name of needed)assert.ok(bravura.has(symbols[name]),`Bravura lacks ${name}`);
  for(const [id,font] of Object.entries(musicFonts)){
    if(!font.metadata)continue;
    const have=pointsOf(font.file);
    const boxes=new Set(neededGlyphs(JSON.parse(text(`assets/fonts/${font.metadata}`))));
    const listed=new Set(substitutes[id]);
    for(const name of needed){
      const present=have.has(symbols[name])&&boxes.has(name);
      if(present)assert.equal(listed.has(name),false,`${id} lists ${name} but has it`);
      else assert.ok(listed.has(name),`${id} lacks ${name}; review it and add it to scripts/music-substitutes.json`);
    }
    for(const name of listed)assert.ok(needed.includes(name),`${id} lists unknown glyph ${name}`);
  }
});

test('coverage_json_is_current',()=>{
  assert.deepEqual(JSON.parse(readFileSync(coveragePath,'utf8')),buildCoverage());
  assert.deepEqual(JSON.parse(readFileSync(substitutesPath,'utf8')),buildSubstitutes({bravuraMetadata}));
  for(const face of faces){
    assert.equal(covers(face.file,0xc4),true);
    assert.equal(covers(face.file,0x10ffff),false);
    for(const point of [0x41,sharp,flat,0x1f600])assert.equal(covers(face.file,point),pointsOf(face.file).has(point),`${face.file} U+${point.toString(16)}`);
  }
  assert.equal(covers('missing.ttf',0x41),false);
});

test('catalog_matches_sources',()=>{
  const catalog=new Set([...faces.map(face=>face.file),...Object.values(musicFonts).map(font=>font.file)]);
  const listed=new Set(sources.map(entry=>entry.filename));
  for(const file of catalog)assert.ok(listed.has(file),`${file} has no sources.json entry`);
  for(const file of listed)assert.ok(catalog.has(file)||fallbackFiles.includes(file),`${file} is in sources.json but not in the catalog`);
  for(const file of fallbackFiles)assert.ok(listed.has(file)&&!catalog.has(file));
  for(const font of Object.values(musicFonts))assert.equal(sources.find(entry=>entry.filename===font.file).smuflMetadata?.filename??null,font.metadata);
  for(const font of Object.values(textFonts))for(const face of font.faces)assert.equal(sources.find(entry=>entry.filename===face.file).family,font.family);
});

test('catalog_faces_follow_the_pinned_set',()=>{
  assert.deepEqual(Object.values(textFonts).map(font=>font.alias),['TabPlayer Sans','TabPlayer Serif','TabPlayer Mono']);
  assert.equal(faceFor('notoSerif',true,true).file,'NotoSerif-BoldItalic.ttf');
  assert.equal(hasFace('notoSansMono',true,false),true);
  assert.equal(hasFace('notoSansMono',false,true),false);
  assert.equal(hasFace('notoSansMono',true,true),false);
});

test('notices_name_every_bundled_font',()=>{
  const notices=text('THIRD_PARTY_NOTICES.md');
  for(const family of new Set(sources.map(entry=>entry.family)))assert.ok(notices.includes(family),`THIRD_PARTY_NOTICES.md does not name ${family}`);
  assert.match(notices,/Reserved Font Name[^.]*Leland|Leland[^.]*Reserved Font Name/);
  assert.match(notices,/Petaluma[^.]*2018/);
  assert.match(notices,/2021/);
});

test('licence_and_metadata_files_exist',()=>{
  for(const entry of sources){
    assert.ok(readFileSync(`${fontsDir}/${entry.licenseFile}`).length>1000,entry.licenseFile);
    if(entry.smuflMetadata)assert.ok(readFileSync(`${fontsDir}/${entry.smuflMetadata.filename}`).length>1000);
  }
});

// Fonts are untrusted input: the reader must stop with a clear error, never read out of range or loop.
function sfnt(cmap,version=0x00010000){
  const bytes=new Uint8Array(28+cmap.length);
  const view=new DataView(bytes.buffer);
  view.setUint32(0,version);view.setUint16(4,1);
  bytes.set([0x63,0x6d,0x61,0x70],12);view.setUint32(20,28);view.setUint32(24,cmap.length);
  bytes.set(cmap,28);
  return bytes;
}
function cmapWith(subtable){
  const bytes=new Uint8Array(12+subtable.length);
  const view=new DataView(bytes.buffer);
  view.setUint16(2,1);view.setUint16(4,3);view.setUint16(6,1);view.setUint32(8,12);
  bytes.set(subtable,12);
  return bytes;
}
const throwsMalformed=bytes=>assert.throws(()=>codePoints(bytes),error=>error instanceof Error&&/Malformed font/.test(error.message));

test('cmap_reader_rejects_truncated_and_garbage_fonts',{timeout:20000},()=>{
  const real=new Uint8Array(readFileSync(`${fontsDir}/NotoSerif-Regular.ttf`));
  for(const length of [0,3,11,12,20,100])throwsMalformed(real.subarray(0,length));
  const directory=new DataView(real.buffer,real.byteOffset);
  let cmapOffset=-1;
  for(let i=0;i<directory.getUint16(4);i++)if(directory.getUint32(12+i*16)===0x636d6170)cmapOffset=directory.getUint32(12+i*16+8);
  assert.ok(cmapOffset>0);
  throwsMalformed(real.subarray(0,cmapOffset+10));
  throwsMalformed(real.subarray(0,cmapOffset+200));
  assert.throws(()=>codePoints('not bytes'),TypeError);
  throwsMalformed(new Uint8Array(64).fill(0x41));
  throwsMalformed(sfnt(new Uint8Array(0)));
  // Format 12 claiming 4 billion groups, and a group range outside Unicode.
  const huge=new Uint8Array(16);const hv=new DataView(huge.buffer);hv.setUint16(0,12);hv.setUint32(4,16);hv.setUint32(12,0xffffffff);
  throwsMalformed(sfnt(cmapWith(huge)));
  const outside=new Uint8Array(28);const ov=new DataView(outside.buffer);ov.setUint16(0,12);ov.setUint32(4,28);ov.setUint32(12,1);ov.setUint32(16,0);ov.setUint32(20,0xffffffff);ov.setUint32(24,1);
  throwsMalformed(sfnt(cmapWith(outside)));
  // Overlapping groups would let a small file force a huge amount of work.
  const overlap=new Uint8Array(40);const lv=new DataView(overlap.buffer);lv.setUint16(0,12);lv.setUint32(4,40);lv.setUint32(12,2);
  lv.setUint32(16,0);lv.setUint32(20,0x10ffff);lv.setUint32(24,1);lv.setUint32(28,5);lv.setUint32(32,0x10ffff);lv.setUint32(36,1);
  throwsMalformed(sfnt(cmapWith(overlap)));
  // Format 4 with a glyph index array pointing past the subtable.
  const f4=new Uint8Array(32);const fv=new DataView(f4.buffer);fv.setUint16(0,4);fv.setUint16(2,32);fv.setUint16(6,4);
  fv.setUint16(14,0x41);fv.setUint16(16,0xffff);fv.setUint16(20,0x41);fv.setUint16(22,0xffff);fv.setUint16(28,0xfff0);
  throwsMalformed(sfnt(cmapWith(f4)));
  // Seeded garbage behind a valid header never hangs and only ever throws a clear error.
  let seed=12345;const next=()=>(seed=(Math.imul(seed,1103515245)+12345)>>>0)>>>8&0xff;
  for(let round=0;round<300;round++){
    const body=Uint8Array.from({length:40+round},next);
    try{codePoints(sfnt(body))}catch(error){assert.ok(error instanceof Error&&/Malformed font/.test(error.message),String(error))}
  }
});
