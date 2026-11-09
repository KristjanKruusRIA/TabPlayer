import { expect,it } from 'vitest';
import { NotationElement,Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { renderPdfPages } from '../export/pdf';
import { configureEngraving,defaultEngraving,validateEngraving } from './projection';
import { notationPresets,presetApplied } from './notation-presets';
import type { EngravingOverrides,EngravingTypography } from './types';
import { FALLBACK_FAMILIES,TAB_NUMBER_FONTS,configureRoleFonts,pageRoleFont,roleElements,type EngravingFonts } from './fonts';
import { hasFace,textFonts } from './font-catalog';
import { configureTypography,defaultTypography,isDefaultTypography,typographyOf,validateTypography,withTypography,tabDigitFloorPercent,MIN_TAB_DIGIT_PX,MIN_DIGIT_HEIGHT_RATIO } from './typography';

const typed=(over:Partial<EngravingTypography>):EngravingTypography=>({...defaultTypography(),...over});
const layout={paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const page={widthMm:210,heightMm:297,marginsMm:{top:15,right:15,bottom:15,left:15},scale:1,profile:'document' as const};
const sizes=(svg:string)=>[...svg.matchAll(/font:\s*(?:italic |bold )?([\d.]+)px/g)].map(match=>Number(match[1]));

it('typography_defaults_are_omitted_so_older_documents_stay_identical',()=>{
  const plain=defaultEngraving();
  expect(plain.typography).toBeUndefined();expect(typographyOf(plain)).toEqual(defaultTypography());
  expect(withTypography(plain,defaultTypography())).toEqual(plain);expect('typography' in withTypography({...plain,typography:typed({family:'serif'})},defaultTypography())).toBe(false);
  const set=withTypography(plain,typed({family:'mono',tabScale:1.25}));
  expect(set.typography).toEqual(typed({family:'mono',tabScale:1.25}));expect(plain.typography).toBeUndefined();
  expect(isDefaultTypography(typed({textScale:1}))).toBe(false);
});

it('typography_validation_matches_the_native_ranges_and_keeps_old_shapes_valid',()=>{
  const base=defaultEngraving();
  expect(()=>validateEngraving(base)).not.toThrow();
  expect(()=>validateEngraving({...base,typography:defaultTypography()})).not.toThrow();
  for(const good of [typed({textScale:.5}),typed({textScale:2}),typed({titleScale:.5}),typed({titleScale:2}),typed({tabScale:.75}),typed({tabScale:1.5}),typed({family:'sans'}),typed({family:'serif'}),typed({family:'mono'})])expect(()=>validateEngraving({...base,typography:good})).not.toThrow();
  for(const bad of [typed({textScale:.49}),typed({textScale:2.01}),typed({titleScale:0}),typed({titleScale:-1}),typed({titleScale:2.01}),typed({tabScale:.74}),typed({tabScale:1.51}),typed({tabScale:Number.NaN}),typed({textScale:Infinity}),typed({textScale:'1' as unknown as number}),typed({family:'comic' as 'sans'}),typed({family:null as unknown as 'sans'})])expect(()=>validateEngraving({...base,typography:bad})).toThrow();
  for(const bad of [null,[],{family:'sans'},{...defaultTypography(),extra:1},undefined])expect(()=>validateEngraving({...base,typography:bad})).toThrow();
  expect(()=>validateTypography(typed({tabScale:1.2}))).not.toThrow();
  expect(()=>validateEngraving({...base,extra:1})).toThrow();
});

it('configureTypography_scales_by_group_and_restarts_from_the_defaults',()=>{
  const defaults=new Settings().display.resources,settings=new Settings(),resources=settings.display.resources;
  configureTypography(settings,typed({textScale:1.5,titleScale:.5,tabScale:1.25}));
  expect(resources.elementFonts.get(NotationElement.ScoreTitle)!.size).toBe(16);
  expect(resources.elementFonts.get(NotationElement.ScoreCopyright)!.size).toBe(6);
  expect(resources.elementFonts.get(NotationElement.EffectText)!.size).toBe(18);
  expect(resources.elementFonts.get(NotationElement.BarNumber)!.size).toBe(16.5);
  expect(resources.tablatureFont.size).toBe(17.5);expect(resources.graceFont.size).toBe(15);
  for(const key of ['numberedNotationFont','numberedNotationGraceFont'] as const)expect(resources[key].size,key).toBe(Math.round(defaults[key].size*12.5)/10);
  expect(resources.elementFonts.get(NotationElement.EffectText)!.families).toEqual(['Georgia','serif']);
  expect(new Settings().display.resources.elementFonts.get(NotationElement.EffectText)!.size).toBe(12);
  configureTypography(settings,defaultTypography());
  for(const [element,font] of defaults.elementFonts){const now=resources.elementFonts.get(element)!;expect([now.size,now.families,now.isBold,now.isItalic]).toEqual([font.size,font.families,font.isBold,font.isItalic]);}
  for(const key of ['tablatureFont','graceFont','numberedNotationFont','numberedNotationGraceFont'] as const)expect([resources[key].size,resources[key].families],key).toEqual([defaults[key].size,defaults[key].families]);
});

it('configureTypography_applies_each_family_to_every_text_font_and_keeps_styles',()=>{
  const settings=new Settings(),original=new Settings().display.resources;
  for(const [family,expected] of [['sans',['Arial','sans-serif']],['serif',['Georgia','serif']],['mono',['Consolas','Courier New','monospace']]] as const){
    configureTypography(settings,typed({family}));
    for(const [element,font] of settings.display.resources.elementFonts){expect(font.families).toEqual(expected);const was=original.elementFonts.get(element)!;expect([font.size,font.isBold,font.isItalic]).toEqual([was.size,was.isBold,was.isItalic]);}
    // Fret and staff numbers keep their own family, so lining digits sit evenly on the tab lines.
    for(const key of ['tablatureFont','graceFont','numberedNotationFont','numberedNotationGraceFont'] as const)expect(settings.display.resources[key].families,key).toEqual(original[key].families);
  }
  expect(()=>configureTypography(settings,typed({textScale:3}))).toThrow();
});

it('configureEngraving_applies_the_documents_typography_and_resets_it',()=>{
  const settings=new Settings(),styled:EngravingOverrides=withTypography(defaultEngraving(),typed({family:'mono',titleScale:2}));
  configureEngraving(settings,styled);
  expect(settings.display.resources.elementFonts.get(NotationElement.ScoreTitle)!.size).toBe(64);
  configureEngraving(settings,defaultEngraving());
  expect(settings.display.resources.elementFonts.get(NotationElement.ScoreTitle)!.size).toBe(32);
  expect(settings.display.resources.elementFonts.get(NotationElement.ScoreTitle)!.families).toEqual(['Georgia','serif']);
});

it('rendering_with_changed_typography_lays_out_every_system_without_error_or_overflow',()=>{
  const score=music(),options=(typography:EngravingTypography)=>({page,engraving:withTypography(defaultEngraving(),typography),trackIds:['base/0']});
  const plain=renderPdfPages(score,{tracks:[0],range:null},layout,options(defaultTypography())).map(entry=>entry.svg).join('');
  const largest=renderPdfPages(score,{tracks:[0],range:null},layout,options(typed({family:'mono',textScale:2,titleScale:2,tabScale:1.5}))).map(entry=>entry.svg).join('');
  const smallest=renderPdfPages(score,{tracks:[0],range:null},layout,options(typed({family:'serif',textScale:.5,titleScale:.5,tabScale:.75}))).map(entry=>entry.svg).join('');
  // renderPdfPages throws when a system does not fit the page width, so reaching here means nothing overflowed.
  expect(Math.max(...sizes(largest))).toBeGreaterThan(Math.max(...sizes(plain)));
  expect(Math.min(...sizes(smallest))).toBeLessThan(Math.min(...sizes(plain)));
  expect(plain).not.toBe(largest);expect(plain).not.toBe(smallest);
});

it('presets_replace_style_choices_but_keep_spacing_and_profiles_and_validate',()=>{
  const current=defaultEngraving();current.systemSpacing=1.5;current.profiles=[{trackId:'base/0',profile:'slash'}];current.stylesheet.hideDynamics=true;
  expect(notationPresets.map(preset=>preset.id)).toEqual(['classic','jazz','rock']);
  const results=notationPresets.map(preset=>{
    const applied=presetApplied(preset,current);validateEngraving(applied);
    expect(applied.systemSpacing).toBe(1.5);expect(applied.profiles).toEqual(current.profiles);expect(applied.profiles).not.toBe(current.profiles);
    expect(applied.stylesheet.hideDynamics).toBe(preset.stylesheet.hideDynamics??null);
    expect(typographyOf(applied)).toEqual(preset.typography);
    return JSON.stringify(applied);
  });
  expect(new Set(results).size).toBe(3);
  expect(current.stylesheet.hideDynamics).toBe(true);
  expect(presetApplied(notationPresets[2],current).notation.tabRhythm).toBe('beams');
});

// ---- D12 font roles on screen (Task 5) ----
const elementFontsOf=(settings:Settings)=>settings.display.resources.elementFonts;
const withRoles=(roles:EngravingFonts['roles']):EngravingFonts=>({roles});
const FamilyOk=/^[A-Za-z]+( [A-Za-z]+)*$/;

it('role_mapping_covers_every_element_once',()=>{
  const all=Object.values(roleElements).flat(),keys=[...new Settings().display.resources.elementFonts.keys()];
  expect(all).toHaveLength(36);
  expect(new Set(all).size).toBe(all.length);
  expect([...new Set(all)].sort((a,b)=>a-b)).toEqual([...keys].sort((a,b)=>a-b));
  expect(TAB_NUMBER_FONTS).toEqual(['tablatureFont','graceFont','numberedNotationFont','numberedNotationGraceFont']);
  expect(FALLBACK_FAMILIES).toEqual(['Noto Sans','Noto Sans CJK JP','Noto Emoji']);
});

it('role_families_have_no_digit_tokens',()=>{
  const settings=new Settings();
  const roles:NonNullable<EngravingFonts['roles']>={};
  for(const role of ['titleBlock','chordNames','staffText','lyrics','trackNames','barNumbers','markers','tabNumbers'] as const)roles[role]={font:role==='markers'?'notoSansMono':role==='lyrics'?'notoSerif':'notoSans'};
  configureRoleFonts(settings,withRoles(roles),defaultTypography());
  const resources=settings.display.resources,written=[...resources.elementFonts.values(),...TAB_NUMBER_FONTS.map(key=>resources[key])].flatMap(font=>font.families);
  expect(written.some(family=>family.startsWith('TabPlayer'))).toBe(true);
  for(const family of [...written,...Object.values(textFonts).map(font=>font.alias),...Object.values(textFonts).map(font=>font.family),...FALLBACK_FAMILIES])expect(family).toMatch(FamilyOk);
});

it('chosen_role_sets_family_style_weight_size',()=>{
  const settings=new Settings(),defaults=new Settings().display.resources.elementFonts,typography=typed({textScale:1.5});
  configureTypography(settings,typography);
  configureRoleFonts(settings,withRoles({lyrics:{font:'notoSerif',italic:false,bold:true,size:1.25},markers:{font:'notoSansMono',size:1.5}}),typography);
  const lyrics=elementFontsOf(settings).get(NotationElement.EffectLyrics)!;
  expect(lyrics.families).toEqual(['TabPlayer Serif','Noto Sans','Noto Sans CJK JP','Noto Emoji']);
  expect(lyrics.isItalic).toBe(false);expect(lyrics.isBold).toBe(true);
  expect(lyrics.size).toBe(Math.round(defaults.get(NotationElement.EffectLyrics)!.size*1.25*10)/10);
  // The role size replaces the group scale (1.5 here); a flag left unset keeps the element's own style (markers are bold).
  const marker=elementFontsOf(settings).get(NotationElement.EffectMarker)!;
  expect(marker.families[0]).toBe('TabPlayer Mono');expect(marker.isBold).toBe(true);expect(marker.size).toBe(21);
  const alternate=elementFontsOf(settings).get(NotationElement.EffectAlternateEndings)!;
  expect(alternate.isBold).toBe(false);expect(alternate.families[0]).toBe('TabPlayer Mono');
});

it('role_size_replaces_the_group_scale_even_when_smaller',()=>{
  const typography=typed({textScale:2}),settings=new Settings();
  configureTypography(settings,typography);configureRoleFonts(settings,withRoles({lyrics:{font:'notoSans',size:.5}}),typography);
  expect(elementFontsOf(settings).get(NotationElement.EffectLyrics)!.size).toBe(6);
  expect(elementFontsOf(settings).get(NotationElement.EffectText)!.size).toBe(24);
});

it('chosen_tab_numbers_role_sets_all_four_number_fonts',()=>{
  const settings=new Settings(),defaults=new Settings().display.resources;
  configureRoleFonts(settings,withRoles({tabNumbers:{font:'notoSerif',bold:true,size:1.25}}),defaultTypography());
  for(const key of TAB_NUMBER_FONTS){
    const font=settings.display.resources[key];
    expect(font.families).toEqual(['TabPlayer Serif','Noto Sans','Noto Sans CJK JP','Noto Emoji']);expect(font.isBold).toBe(true);expect(font.size).toBe(Math.round(defaults[key].size*1.25*10)/10);
  }
});

it('unchosen_roles_keep_typography_result',()=>{
  const typography=typed({family:'serif',textScale:1.2,titleScale:.8,tabScale:1.1}),alone=new Settings(),both=new Settings();
  configureTypography(alone,typography);configureTypography(both,typography);
  configureRoleFonts(both,withRoles({lyrics:{font:'notoSerif'}}),typography);
  const a=alone.display.resources,b=both.display.resources;
  for(const [element,font] of a.elementFonts)if(!roleElements.lyrics.includes(element))expect(b.elementFonts.get(element)).toEqual(font);
  for(const key of TAB_NUMBER_FONTS)expect(b[key]).toEqual(a[key]);
  // Fonts that choose nothing leave the earlier result alone: configureRoleFonts only touches roles that are present.
  configureRoleFonts(both,undefined,typography);configureRoleFonts(both,{},typography);configureRoleFonts(both,{music:'petaluma'},typography);configureRoleFonts(both,withRoles({pageHeader:{font:'notoSerif'}}),typography);
  expect(b.elementFonts.get(NotationElement.EffectText)).toEqual(a.elementFonts.get(NotationElement.EffectText));
  expect(b.elementFonts.get(NotationElement.EffectLyrics)!.families[0]).toBe('TabPlayer Serif');
});

it('size_only_role_scales_without_family',()=>{
  const typography=typed({family:'mono',textScale:2}),settings=new Settings(),defaults=new Settings().display.resources;
  configureTypography(settings,typography);configureRoleFonts(settings,withRoles({trackNames:{size:.5},tabNumbers:{size:1.5}}),typography);
  const track=settings.display.resources.elementFonts.get(NotationElement.TrackNames)!,original=defaults.elementFonts.get(NotationElement.TrackNames)!;
  expect(track.size).toBe(6);expect(track.families).toEqual(['Consolas','Courier New','monospace']);expect(track.isItalic).toBe(original.isItalic);expect(track.isBold).toBe(original.isBold);
  expect(settings.display.resources.tablatureFont.size).toBe(21);expect(settings.display.resources.tablatureFont.families).toEqual(defaults.tablatureFont.families);
});

it('reconfigure_restores_defaults',()=>{
  const settings=new Settings(),defaults=new Settings().display.resources;
  const chosen={...defaultEngraving(),fonts:withRoles({lyrics:{font:'notoSerif',italic:true,size:2},tabNumbers:{font:'notoSansMono',size:1.5}})};
  configureEngraving(settings,chosen);
  expect(settings.display.resources.elementFonts.get(NotationElement.EffectLyrics)!.families[0]).toBe('TabPlayer Serif');
  expect(settings.display.resources.tablatureFont.families[0]).toBe('TabPlayer Mono');
  configureEngraving(settings,defaultEngraving());
  for(const [element,font] of defaults.elementFonts)expect(settings.display.resources.elementFonts.get(element)).toEqual(font);
  for(const key of TAB_NUMBER_FONTS)expect(settings.display.resources[key]).toEqual(defaults[key]);
});

it('mono_role_draws_default_italic_elements_upright',()=>{
  const settings=new Settings(),defaults=new Settings().display.resources.elementFonts;
  expect(defaults.get(NotationElement.EffectLyrics)!.isItalic).toBe(true);
  configureRoleFonts(settings,withRoles({lyrics:{font:'notoSansMono'},staffText:{font:'notoSansMono',bold:true},trackNames:{font:'notoSerif'}}),defaultTypography());
  const fonts=elementFontsOf(settings);
  expect(fonts.get(NotationElement.EffectLyrics)!.isItalic).toBe(false);
  expect(fonts.get(NotationElement.EffectText)!.isItalic).toBe(false);expect(fonts.get(NotationElement.EffectText)!.isBold).toBe(true);
  expect(fonts.get(NotationElement.TrackNames)!.isItalic).toBe(true);
  expect(hasFace('notoSansMono',false,true)).toBe(false);
});

it('page_role_font_reads_family_flags_and_scale',()=>{
  expect(pageRoleFont(undefined,'pageHeader')).toEqual({family:null,bold:false,italic:false,scale:null});
  expect(pageRoleFont({roles:{pageHeader:{size:1.5}}},'pageHeader')).toEqual({family:null,bold:false,italic:false,scale:1.5});
  expect(pageRoleFont({roles:{pageFooter:{font:'notoSerif',bold:true,italic:true}}},'pageFooter')).toEqual({family:'TabPlayer Serif',bold:true,italic:true,scale:null});
  expect(pageRoleFont({roles:{pageFooter:{font:'notoSansMono',italic:true}}},'pageFooter')).toEqual({family:'TabPlayer Mono',bold:false,italic:false,scale:null});
  expect(pageRoleFont({roles:{pageFooter:{font:'notoSerif'}}},'pageHeader')).toEqual({family:null,bold:false,italic:false,scale:null});
});

it('tabDigitFloorPercent_keeps_the_smallest_tab_digit_at_least_7_5_px_and_falls_for_larger_tab_fonts',()=>{
  const font=new Settings().display.resources.tablatureFont.size;
  expect(font).toBe(14);
  expect(tabDigitFloorPercent(null)).toBe(63);
  expect(tabDigitFloorPercent(1)).toBe(63);
  for(const scale of [null,.75,1,1.25,1.5]){
    const floor=tabDigitFloorPercent(scale),digit=Math.round(font*(scale??1)*10)/10*MIN_DIGIT_HEIGHT_RATIO;
    expect(digit*floor/100,String(scale)).toBeGreaterThanOrEqual(MIN_TAB_DIGIT_PX);
    expect(digit*(floor-1)/100,String(scale)).toBeLessThan(MIN_TAB_DIGIT_PX);
  }
  expect(tabDigitFloorPercent(1.5)).toBeLessThan(tabDigitFloorPercent(1));
  expect(tabDigitFloorPercent(1)).toBeLessThan(tabDigitFloorPercent(.75));
  expect(tabDigitFloorPercent(.75)).toBe(84);
  expect(tabDigitFloorPercent(.1)).toBe(100);
  expect(tabDigitFloorPercent(10)).toBe(25);
});
