import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultEngraving,validateEngraving } from './projection';
import type { EngravingFonts } from './fonts';
import { FONT_ROLES,fontsOf,isDefaultFonts,missingGlyphs,roleTexts,sizeRange,validateFonts,withFonts,withoutMusicFont,withoutPageFonts } from './fonts';
import { model } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { defaultHeaderFooter,headerFieldsOf } from './header-footer';
import { engravingRenderKey } from './system-gaps';
import { defaultTypography,validateTypography } from './typography';

// Read with JSON.parse (not a module import): a bundled object literal would turn a `__proto__` key into a prototype, not an own key.
const cases=JSON.parse(readFileSync(new URL('../../tests/fixtures/engraving-fonts-cases.json',import.meta.url),'utf8')) as {valid:{name:string;fonts:unknown}[];invalid:{name:string;fonts:unknown}[]};
const base=()=>defaultEngraving();

it('validation_cases_from_fixture',()=>{
  expect(cases.valid.length).toBeGreaterThan(10);expect(cases.invalid.length).toBeGreaterThan(30);
  for(const {name,fonts} of cases.valid){
    expect(()=>validateFonts(fonts),name).not.toThrow();
    expect(()=>validateEngraving({...base(),fonts}),name).not.toThrow();
  }
  for(const {name,fonts} of cases.invalid){
    expect(()=>validateFonts(fonts),name).toThrow();
    expect(()=>validateEngraving({...base(),fonts}),name).toThrow();
  }
});

it('fixture_covers_every_role_and_both_range_edges',()=>{
  const text=JSON.stringify(cases);
  for(const role of FONT_ROLES)expect(text).toContain(`"${role}"`);
  expect(FONT_ROLES).toHaveLength(10);
  expect(sizeRange('tabNumbers')).toEqual({min:.75,max:1.5});
  for(const role of FONT_ROLES.filter(role=>role!=='tabNumbers'))expect(sizeRange(role)).toEqual({min:.5,max:2});
});

it('with_fonts_normalizes_defaults_away',()=>{
  const plain=base();
  for(const fonts of [{},{music:'bravura'},{roles:{}},{music:'bravura',roles:{}},{music:undefined,roles:undefined}] as EngravingFonts[]){
    const next=withFonts(plain,fonts);
    expect('fonts' in next).toBe(false);expect(next).toEqual(plain);expect(next).not.toBe(plain);
  }
  // Starting from a document that already has fonts, a default result drops the key again.
  const set=withFonts(plain,{music:'leland'});expect(set.fonts).toEqual({music:'leland'});
  expect('fonts' in withFonts(set,{})).toBe(false);
  // P12: undefined keys and empty role entries vanish; flags whose font was removed vanish with it.
  expect(withFonts(plain,{roles:{lyrics:{font:undefined,size:undefined,bold:undefined,italic:undefined}}} as EngravingFonts)).toEqual(plain);
  expect(withFonts(plain,{roles:{lyrics:{}}})).toEqual(plain);
  expect(withFonts(plain,{roles:{lyrics:{font:undefined,bold:true}}})).toEqual(plain);
  expect(withFonts(plain,{roles:{lyrics:{font:undefined,italic:false}}})).toEqual(plain);
  expect(withFonts(plain,{roles:{lyrics:{font:undefined,size:1.5,bold:true,italic:true}}}).fonts).toEqual({roles:{lyrics:{size:1.5}}});
  expect(withFonts(plain,{music:'petaluma',roles:{lyrics:{font:'notoSerif',size:undefined,bold:undefined,italic:true},markers:{}}}).fonts).toEqual({music:'petaluma',roles:{lyrics:{font:'notoSerif',italic:true}}});
  // An explicit false is a choice (the element's own default may be bold or italic), so it stays.
  expect(withFonts(plain,{roles:{markers:{font:'notoSansMono',bold:false}}}).fonts).toEqual({roles:{markers:{font:'notoSansMono',bold:false}}});
  // Every normalized result is valid.
  for(const fonts of [{roles:{lyrics:{font:undefined,bold:true}}},{roles:{lyrics:{size:1}}},{music:'leland'}] as EngravingFonts[])expect(()=>validateEngraving(withFonts(plain,fonts))).not.toThrow();
  // The result is a new object: neither the input engraving nor the input fonts change.
  const input:EngravingFonts={music:'bravura',roles:{lyrics:{font:'notoSerif',bold:undefined}}},snapshot=structuredClone(input),engraving=structuredClone(set);
  const out=withFonts(engraving,input);
  expect(input).toEqual(snapshot);expect(engraving).toEqual(set);expect(out).not.toBe(engraving);
  expect(out.fonts).toEqual({roles:{lyrics:{font:'notoSerif'}}});
  expect(out.fonts).not.toBe(input);expect(out.fonts!.roles!.lyrics).not.toBe(input.roles!.lyrics);
});

it('fonts_of_and_is_default_fonts_read_the_optional_field',()=>{
  expect(fontsOf({})).toEqual({music:'bravura',roles:{}});
  expect(fontsOf({fonts:{music:'leland',roles:{lyrics:{font:'notoSerif'}}}})).toEqual({music:'leland',roles:{lyrics:{font:'notoSerif'}}});
  const source:EngravingFonts={roles:{lyrics:{font:'notoSerif'}}},copy=fontsOf({fonts:source});
  copy.roles.lyrics!.font='notoSans';expect(source.roles!.lyrics!.font).toBe('notoSerif');
  expect(isDefaultFonts(undefined)).toBe(true);expect(isDefaultFonts({})).toBe(true);expect(isDefaultFonts({music:'bravura',roles:{}})).toBe(true);
  expect(isDefaultFonts({roles:{lyrics:{}}})).toBe(true);
  expect(isDefaultFonts({music:'petaluma'})).toBe(false);expect(isDefaultFonts({roles:{lyrics:{size:1}}})).toBe(false);
});

it('validate_engraving_allows_optional_fonts_only_when_present',()=>{
  const plain=base();
  expect(()=>validateEngraving(plain)).not.toThrow();
  expect('fonts' in plain).toBe(false);
  expect(()=>validateEngraving({...plain,fonts:{}})).not.toThrow();
  expect(()=>validateEngraving({...plain,fonts:{music:'petaluma'}})).not.toThrow();
  // A present but undefined or null field is not "absent".
  expect(()=>validateEngraving({...plain,fonts:undefined})).toThrow();
  expect(()=>validateEngraving({...plain,fonts:null})).toThrow();
  // Other unknown root keys stay refused, with or without fonts.
  expect(()=>validateEngraving({...plain,extra:1})).toThrow();
  expect(()=>validateEngraving({...plain,fonts:{},extra:1})).toThrow();
});

it('typography_exact_keys_unchanged',()=>{
  expect(Object.keys(defaultTypography())).toEqual(['family','textScale','titleScale','tabScale']);
  expect(()=>validateTypography(defaultTypography())).not.toThrow();
  expect(()=>validateTypography({...defaultTypography(),fonts:{}})).toThrow();
  expect(()=>validateTypography({...defaultTypography(),music:'bravura'})).toThrow();
  expect(()=>validateEngraving({...base(),typography:{...defaultTypography(),fonts:{}}})).toThrow();
});

it('render_key_ignores_page_header_and_footer_fonts',()=>{
  const lyrics={font:'notoSerif' as const};
  const plain=withFonts(base(),{roles:{lyrics}}),paged=withFonts(base(),{roles:{lyrics,pageHeader:{font:'notoSansMono',size:1.5},pageFooter:{bold:true,font:'notoSerif'}}});
  expect(engravingRenderKey(paged)).toBe(engravingRenderKey(plain));
  expect(withoutPageFonts(paged)).toEqual(plain);expect(paged.fonts?.roles?.pageHeader).toBeDefined();
  // Page roles alone leave no fonts at all; an engraving without page roles comes back as it is.
  expect(withoutPageFonts(withFonts(base(),{roles:{pageHeader:{size:2}}}))).toEqual(base());
  expect(withoutPageFonts(plain)).toBe(plain);
  // Screen roles and the music font still change the key.
  expect(engravingRenderKey(withFonts(base(),{roles:{lyrics:{font:'notoSansMono'}}}))).not.toBe(engravingRenderKey(plain));
  expect(engravingRenderKey(withFonts(base(),{music:'leland',roles:{lyrics}}))).not.toBe(engravingRenderKey(plain));
});

it('without_music_font_keeps_role_choices_and_drops_the_music_choice',()=>{
  const both=withFonts(base(),{music:'petaluma',roles:{lyrics:{font:'notoSerif'}}});
  expect(withoutMusicFont(both)).toEqual(withFonts(base(),{roles:{lyrics:{font:'notoSerif'}}}));
  // Music alone leaves no fonts field at all, and an engraving with no music choice comes back as it is.
  expect(withoutMusicFont(withFonts(base(),{music:'leland'}))).toEqual(base());
  expect(withoutMusicFont(withFonts(base(),{music:'leland'})).fonts).toBeUndefined();
  const plain=withFonts(base(),{roles:{lyrics:{size:1.5}}});
  expect(withoutMusicFont(plain)).toBe(plain);
  expect(both.fonts?.music).toBe('petaluma');
});

const scoreWithText=()=>{
  const score=music(),track=score.tracks[0],staff=track.staves[0],beats=staff.bars[0].voices[0].beats;
  score.title='Tiitel';score.artist='Ä Band';track.name='Kitarr';track.shortName='Kit';
  beats[0].lyrics=['la','中'];beats[1].text='rit.';
  const chord=new model.Chord();chord.name='Cmaj7';beats[2].chordId='c1';staff.addChord('c1',chord);
  const section=new model.Section();section.marker='A';section.text='Verse ŋ';score.masterBars[0].section=section;
  return score;
};

it('role_texts_collect_the_scores_own_text_per_role',()=>{
  const score=scoreWithText(),texts=roleTexts(score,headerFieldsOf(score));
  expect(texts.titleBlock).toEqual(expect.arrayContaining(['Tiitel','Ä Band']));
  expect(texts.lyrics).toEqual(['la','中']);
  expect(texts.staffText).toEqual(['rit.']);
  expect(texts.chordNames).toEqual(['Cmaj7']);
  expect(texts.trackNames).toEqual(expect.arrayContaining(['Kitarr','Kit']));
  expect(texts.markers).toEqual(expect.arrayContaining(['A','Verse ŋ']));
  // The default page puts the title in the header and "page / pages" in the footer.
  expect(texts.pageHeader).toEqual(['Tiitel']);expect(texts.pageFooter).toEqual(['1 / 1']);
  // Numbers-only roles are not listed, and empty roles are left out.
  expect(texts.barNumbers).toBeUndefined();expect(texts.tabNumbers).toBeUndefined();
});

it('role_texts_use_the_given_header_and_footer_bands_and_skip_empty_roles',()=>{
  const score=music(),bands=defaultHeaderFooter();
  bands.other.header.right='%ARTIST% ŋ';bands.first.footer.left='%COPYRIGHT%';
  score.artist='Zoë';score.copyright='© me';
  const texts=roleTexts(score,headerFieldsOf(score),bands);
  expect(texts.pageHeader).toEqual(expect.arrayContaining(['Zoë ŋ']));expect(texts.pageFooter).toEqual(expect.arrayContaining(['© me']));
  // A score with no text has only the page numbers and the track name.
  expect(Object.keys(roleTexts(music(),headerFieldsOf(music())))).toEqual(['pageFooter','trackNames']);
});

it('missing_glyphs_name_the_role_and_every_missing_character_once',()=>{
  const texts={lyrics:['la','中中','x 中 日'],staffText:['中'],trackNames:['Ä']};
  // No role has a font: nothing to warn about.
  expect(missingGlyphs(undefined,texts)).toEqual([]);expect(missingGlyphs({roles:{lyrics:{size:1.5}}},texts)).toEqual([]);
  expect(missingGlyphs({roles:{lyrics:{font:'notoSerif'},trackNames:{font:'notoSans'}}},texts)).toEqual([{role:'lyrics',chars:['中','日']}]);
  // Latin letters with diacritics are in every bundled face.
  expect(missingGlyphs({roles:{trackNames:{font:'notoSansMono'}}},{trackNames:['Ä ŋ']})).toEqual([]);
  // Roles come out in role order.
  expect(missingGlyphs({roles:{staffText:{font:'notoSerif'},lyrics:{font:'notoSerif'}}},texts).map(entry=>entry.role)).toEqual(['staffText','lyrics']);
});

it('missing_glyphs_ignore_spaces_and_controls_and_count_astral_characters_once',()=>{
  expect(missingGlyphs({roles:{lyrics:{font:'notoSerif'}}},{lyrics:['a\tb\u0085  ']})).toEqual([]);
  expect(missingGlyphs({roles:{lyrics:{font:'notoSans'}}},{lyrics:['\u{1F600}']})).toEqual([{role:'lyrics',chars:['\u{1F600}']}]);
});
