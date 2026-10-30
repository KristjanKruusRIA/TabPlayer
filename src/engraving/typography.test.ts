import { expect,it } from 'vitest';
import { NotationElement,Settings } from '@coderline/alphatab';
import { music } from '../editor/fixtures';
import { renderPdfPages } from '../export/pdf';
import { configureEngraving,defaultEngraving,validateEngraving } from './projection';
import { notationPresets,presetApplied } from './notation-presets';
import type { EngravingOverrides,EngravingTypography } from './types';
import { configureTypography,defaultTypography,isDefaultTypography,typographyOf,validateTypography,withTypography } from './typography';

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
  expect(resources.elementFonts.get(NotationElement.EffectText)!.families).toEqual(['Georgia','serif']);
  expect(new Settings().display.resources.elementFonts.get(NotationElement.EffectText)!.size).toBe(12);
  configureTypography(settings,defaultTypography());
  for(const [element,font] of defaults.elementFonts){const now=resources.elementFonts.get(element)!;expect([now.size,now.families,now.isBold,now.isItalic]).toEqual([font.size,font.families,font.isBold,font.isItalic]);}
  expect([resources.tablatureFont.size,resources.tablatureFont.families]).toEqual([defaults.tablatureFont.size,defaults.tablatureFont.families]);
});

it('configureTypography_applies_each_family_to_every_text_font_and_keeps_styles',()=>{
  const settings=new Settings(),original=new Settings().display.resources;
  for(const [family,expected] of [['sans',['Arial','sans-serif']],['serif',['Georgia','serif']],['mono',['Consolas','Courier New','monospace']]] as const){
    configureTypography(settings,typed({family}));
    for(const [element,font] of settings.display.resources.elementFonts){expect(font.families).toEqual(expected);const was=original.elementFonts.get(element)!;expect([font.size,font.isBold,font.isItalic]).toEqual([was.size,was.isBold,was.isItalic]);}
    expect(settings.display.resources.tablatureFont.families).toEqual(expected);expect(settings.display.resources.graceFont.families).toEqual(expected);
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
