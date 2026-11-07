import { beforeEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EngravingSettings,model,Settings } from '@coderline/alphatab';
import { buildScore,trackIdentity } from '../engine';
import { blankProject } from '../project';
import { defaultPrintLayout } from '../document-settings';
import { defaultEngraving } from '../engraving/projection';
import { withFonts,type EngravingFonts } from '../engraving/fonts';
import { mergeSmuflMetadata } from '../engraving/smufl';
import type { MusicFontData } from '../engraving/font-loading';
import type { PageLayout } from '../engraving/types';
import { applyExportFamilies,renderPdfPages } from './pdf';
import * as bounds from './text-bounds';

vi.mock('./text-bounds',async importOriginal=>({...await importOriginal<typeof import('./text-bounds')>(),assertTextFits:vi.fn()}));

const noto='"Noto Sans", "Noto Sans CJK JP", "Noto Emoji"';
const page:PageLayout={widthMm:297,heightMm:210,marginsMm:{top:10,right:10,bottom:10,left:10},scale:1,profile:'document'};
function scoreWithText(){
  const score=buildScore(blankProject()),beat=score.tracks[0].staves[0].bars[0].voices[0].beats[0],note=new model.Note();
  note.string=6;note.fret=0;beat.addNote(note);beat.isEmpty=false;beat.lyrics=['la'];
  const bar=score.masterBars[0];bar.section=new model.Section();bar.section.marker='A';bar.section.text='Intro';
  return score;
}
const render=(fonts:EngravingFonts|undefined,music?:MusicFontData)=>{
  const score=scoreWithText(),engraving=fonts?withFonts(defaultEngraving(),fonts):defaultEngraving();
  return renderPdfPages(score,{tracks:[0],range:null},defaultPrintLayout(),{page,engraving,trackIds:score.tracks.map(trackIdentity),music}).map(p=>p.svg).join('');
};
/** The `<text>` element (opening tag and content) that reads `content`, a regular expression source. */
const textOf=(svg:string,content:string)=>new RegExp(`<text[^>]*>${content}</text>`).exec(svg)?.[0];
const petaluma=():MusicFontData=>{
  const {metadata,substituted}=mergeSmuflMetadata(JSON.parse(readFileSync('assets/fonts/petaluma_metadata.json','utf8')),EngravingSettings.bravuraMetadata);
  return {id:'petaluma',families:['Petaluma','TabPlayer Bravura'],metadata,substituted};
};
beforeEach(()=>vi.mocked(bounds.assertTextFits).mockClear());

describe('export with role fonts',()=>{
  it('export_keeps_noto_for_unchosen_roles_and_alias_for_chosen',()=>{
    // No fonts: nothing mentions an alias and every text is the Noto stack, as before.
    const plain=render(undefined);
    expect(plain).not.toContain('TabPlayer');expect(textOf(plain,'la')).toContain(`font:italic 12px ${noto}`);
    // Lyrics chosen: lyrics keep their italic with the alias first; markers and fret numbers are untouched.
    const chosen=render({roles:{lyrics:{font:'notoSerif'}}});
    expect(textOf(chosen,'la')).toContain(`font:italic 12px "TabPlayer Serif", ${noto}`);
    expect(textOf(chosen,'\\[A\\] Intro')).toContain(`font:bold 14px ${noto}`);
    expect(textOf(chosen,'0')).toContain(`font:14px ${noto}`);
    expect([...chosen.matchAll(/TabPlayer Serif/g)]).toHaveLength(1);
    // Explicit weight and slant, and a mono face on the markers and the fret numbers.
    const styled=render({roles:{lyrics:{font:'notoSerif',bold:true,italic:false},markers:{font:'notoSansMono'},tabNumbers:{font:'notoSansMono'}}});
    expect(textOf(styled,'la')).toContain('font:bold 12px "TabPlayer Serif"');
    expect(textOf(styled,'\\[A\\] Intro')).toContain('font:bold 14px "TabPlayer Mono"');
    expect(textOf(styled,'0')).toContain('font:14px "TabPlayer Mono"');
    // A size-only role keeps the Noto stack and takes its size.
    const sized=render({roles:{lyrics:{size:1.5}}});
    expect(sized).not.toContain('TabPlayer');expect(textOf(sized,'la')).toContain(`font:italic 18px ${noto}`);
  });
  it('applyExportFamilies_replaces_families_only_of_roles_without_a_chosen_font',()=>{
    const settings=new Settings(),elements=settings.display.resources.elementFonts,resources=settings.display.resources;
    for(const font of elements.values())font.families=['Alias'];
    resources.tablatureFont.families=['Alias'];resources.graceFont.families=['Alias'];
    applyExportFamilies(settings,{roles:{lyrics:{font:'notoSerif'},tabNumbers:{font:'notoSansMono'},markers:{size:1.5}}});
    const kept=[...elements].filter(([,font])=>font.families.join()==='Alias').length,stack=['Noto Sans','Noto Sans CJK JP','Noto Emoji'];
    // Only Lyrics (one element) kept its families; the size-only Markers role and everything else got the stack.
    expect(kept).toBe(1);expect(resources.tablatureFont.families).toEqual(['Alias']);expect(resources.graceFont.families).toEqual(['Alias']);
    expect([...elements.values()].filter(font=>font.families.join()===stack.join())).toHaveLength(elements.size-1);
    applyExportFamilies(settings,undefined);
    expect([...elements.values()].every(font=>font.families.join()===stack.join())).toBe(true);expect(resources.tablatureFont.families).toEqual(stack);
  });
  it('page_text_attributes_only_when_role_set',()=>{
    const header=(svg:string)=>/<text x="[\d.]+" y="[\d.]+"[^>]*>Untitled<\/text>/.exec(svg)![0];
    const footer=(svg:string)=>/<text[^>]*>1 \/ 1<\/text>/.exec(svg)![0];
    const plain=render(undefined);
    expect(header(plain)).toMatch(/ font-family="Noto Sans, Noto Sans CJK JP, Noto Emoji" font-size="18">Untitled<\/text>$/);
    expect(header(plain)).not.toMatch(/font-weight|font-style/);
    expect(footer(plain)).toContain(' font-family="Noto Sans, Noto Sans CJK JP, Noto Emoji" font-size="11"');
    const chosen=render({roles:{pageHeader:{font:'notoSerif',bold:true,italic:true},pageFooter:{font:'notoSansMono'}}});
    expect(header(chosen)).toContain(' font-family="TabPlayer Serif, Noto Sans, Noto Sans CJK JP, Noto Emoji" font-weight="700" font-style="italic" font-size="18"');
    expect(footer(chosen)).toContain(' font-family="TabPlayer Mono, Noto Sans, Noto Sans CJK JP, Noto Emoji" font-size="11"');
    expect(footer(chosen)).not.toMatch(/font-weight|font-style/);
    // A size-only header role scales the line without naming a family.
    expect(header(render({roles:{pageHeader:{size:2}}}))).toContain(' font-family="Noto Sans, Noto Sans CJK JP, Noto Emoji" font-size="36"');
  });
  it('export_music_css_uses_chosen_family',()=>{
    expect(render(undefined)).toContain('.at{font-family:Bravura;font-size:36px}');
    const svg=render({music:'petaluma'},petaluma());
    expect(svg).toContain('.at{font-family:Petaluma,Bravura;font-size:36px}');expect(svg).not.toContain('TabPlayer Bravura');
    expect(render({music:'leland'},{...petaluma(),id:'leland'})).toContain('.at{font-family:Leland,Bravura;font-size:36px}');
    // The layout was made from the chosen font's metrics, so the page differs from Bravura's beyond the stylesheet.
    expect(svg.replace('Petaluma,Bravura','Bravura')).not.toBe(render(undefined));
    // A font that is not loaded is refused instead of silently drawn in Bravura.
    expect(()=>render({music:'petaluma'})).toThrow('Music font is not loaded.');
  });
  it('fit_check_runs_when_fonts_set',()=>{
    render(undefined);expect(bounds.assertTextFits).not.toHaveBeenCalled();
    render({music:'petaluma'},petaluma());expect(bounds.assertTextFits).not.toHaveBeenCalled();
    render({roles:{lyrics:{font:'notoSerif'}}});expect(bounds.assertTextFits).toHaveBeenCalledTimes(1);
    // A size-only role is checked too: a 200% annotation is exactly what overflows.
    render({roles:{staffText:{size:2}}});expect(bounds.assertTextFits).toHaveBeenCalledTimes(2);
    render({roles:{pageFooter:{size:1.5}}});expect(bounds.assertTextFits).toHaveBeenCalledTimes(3);
  });
});
