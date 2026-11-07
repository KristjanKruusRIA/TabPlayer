import { expect,it } from 'vitest';
import cases from '../../tests/fixtures/engraving-fonts-cases.json';
import { defaultEngraving,validateEngraving } from './projection';
import type { EngravingFonts } from './fonts';
import { FONT_ROLES,fontsOf,isDefaultFonts,sizeRange,validateFonts,withFonts } from './fonts';
import { defaultTypography,validateTypography } from './typography';

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
