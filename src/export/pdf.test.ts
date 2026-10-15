import { describe, expect, it } from 'vitest';
import { blankProject } from '../project';
import { buildScore, previewEdit } from '../engine';
import { paginateSystems, renderPdfPages } from './pdf';
import { writeFileSync,mkdirSync } from 'node:fs';
import { model,Settings } from '@coderline/alphatab';
import { music,noteAt } from '../editor/fixtures';
import { defaultEngraving } from '../engraving/projection';

const layout = {paper:'A4' as const,orientation:'portrait' as const,marginMm:15,scale:1,profile:'ScoreTab' as const};
const system=(height:number,id:string)=>({width:680,height,svg:`<svg xmlns="http://www.w3.org/2000/svg"><path id="${id}" d="M0 0L10 10"/></svg>`});
describe('vector notation pagination',()=>{
  it('uses explicit custom pages and shared engraving without changing musical sources',()=>{
    const score=music();score.title='A & B';score.artist='HEADER MUST NOT REPEAT';score.defaultSystemsLayout=1;
    const before=model.JsonConverter.scoreToJson(score),engraving=defaultEngraving(),page={widthMm:250,heightMm:350,marginsMm:{top:12,right:22,bottom:32,left:42},scale:.8,profile:'document' as const};
    const options={page,engraving,trackIds:['base/0']},plain=renderPdfPages(score,{tracks:[0],range:null},layout,options);
    expect(plain[0]).toMatchObject({widthMm:250,heightMm:350});expect(plain.map(p=>p.svg).join('')).not.toContain('HEADER MUST NOT REPEAT');
    expect(plain[0].svg).toContain(`translate(${42*96/25.4} ${12*96/25.4+40})`);expect(plain[0].svg).toContain('A &amp; B');
    engraving.stylesheet.hideDynamics=true;const hidden=renderPdfPages(score,{tracks:[0],range:null},layout,options);
    expect(hidden.map(p=>p.svg).join('')).not.toBe(plain.map(p=>p.svg).join(''));expect(model.JsonConverter.scoreToJson(score)).toBe(before);
  });
  it('validates selected temporary profile applicability and keeps unselected instruments independent',()=>{
    const score=music();score.addTrack(music().tracks[0]);score.tracks[1].staves[0].stringTuning.tunings=[];score.finish(new Settings());
    const options={page:{widthMm:297,heightMm:420,marginsMm:{top:15,right:15,bottom:15,left:15},scale:.75,profile:'Tab' as const},engraving:defaultEngraving(),trackIds:['base/0','base/1']};
    expect(renderPdfPages(score,{tracks:[0],range:null},layout,options).length).toBeGreaterThan(0);
    expect(()=>renderPdfPages(score,{tracks:[1],range:null},layout,options)).toThrow(/tablature|tuned/i);
  });
  it('packs complete systems onto physical pages with escaped headers and page numbers',()=>{
    const pages=paginateSystems([system(450,'first'),system(450,'second'),system(450,'third')],'A&B <solo>',layout);
    expect(pages).toHaveLength(2);expect(pages[0].widthMm).toBe(210);expect(pages[0].heightMm).toBe(297);
    expect(pages[0].svg).toContain('id="first"');expect(pages[0].svg).not.toContain('id="third"');
    expect(pages[1].svg).toContain('id="third"');expect(pages[0].svg).toContain('A&amp;B &lt;solo&gt;');
    expect(pages[1].svg).toContain('2 / 2');
  });
  it('uses Letter landscape dimensions and rejects a system that would clip',()=>{
    expect(paginateSystems([system(100,'small')],'',{...layout,paper:'Letter',orientation:'landscape'})[0]).toMatchObject({widthMm:279.4,heightMm:215.9});
    expect(()=>paginateSystems([system(1100,'tall')],'',layout)).toThrow(/system.*fit/i);
    expect(()=>paginateSystems([system(100,'wide')],'',{...layout,marginMm:100})).toThrow(/width|margin/i);
    expect(()=>paginateSystems([system(100,'x')],'',{...layout,scale:NaN})).toThrow(/scale/i);
  });
  it('renders authored notation through public SVG renderer without mutating the score',()=>{
    const project=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:1,fret:3}).project;
    const score=buildScore(project);score.defaultSystemsLayout=1;score.systemsLayout=[1,1,1,1];
    const staff=score.tracks[0].staves[0],beat=staff.bars[0].voices[0].beats[0],note=beat.notes[0];note.isPalmMute=true;note.vibrato=model.VibratoType.Slight;note.bendType=model.BendType.Bend;note.addBendPoint(new model.BendPoint(0,0));note.addBendPoint(new model.BendPoint(60,4));beat.text='Palm mute & bend';
    const chord=new model.Chord();chord.staff=staff;chord.name='Gm';chord.firstFret=1;chord.strings=[3,5,5,3,3,3];chord.showDiagram=true;chord.showName=true;staff.addChord('g-minor',chord);beat.chordId='g-minor';
    const pages=renderPdfPages(score,{tracks:[0],range:{first:0,last:1}},layout);
    expect(pages.length).toBeGreaterThan(0);expect(pages[0].svg).toContain('<rect');
    expect(pages[0].svg).toContain('Bravura');expect(score.tracks[0].staves[0].showTablature).toBe(true);
    expect(pages[0].svg).toContain('Palm mute &amp; bend');expect(pages[0].svg).toContain('Gm');expect(pages[0].svg).toContain('<path');mkdirSync('.analysis/expansion',{recursive:true});writeFileSync('.analysis/expansion/notation-pages.json',JSON.stringify(pages));
    expect(pages[0].svg.match(/>Untitled<\/text>/g)).toHaveLength(1);expect(score.title).toBe('Untitled');
    expect(()=>renderPdfPages(score,{tracks:[],range:null},layout)).toThrow(/track/i);
    expect(()=>renderPdfPages(score,{tracks:[0],range:{first:1.5,last:2}},layout)).toThrow(/range/i);
  });
  it('rejects a model system whose natural contents exceed the usable page width',()=>{
    const project=blankProject();if(project.base.kind==='blank')project.base.measureCount=40;
    const score=buildScore(project);score.tracks[0].defaultSystemsLayout=40;score.defaultSystemsLayout=40;
    expect(()=>renderPdfPages(score,{tracks:[0],range:null},{...layout,profile:'Tab'})).toThrow(/system.*fit/i);
    score.tracks[0].lineBreaks=new Set([3,6,9,12,15,18,21,24,27,30,33,36,39]);expect(renderPdfPages(score,{tracks:[0],range:null},{...layout,profile:'Tab'}).length).toBeGreaterThan(1);
  });
  it('renders an authored nonadjacent cross-string phrase slur as an additional vector curve',()=>{
    const score=music(),origin=noteAt(score),destination=noteAt(score,2);destination.string=5;destination.fret=7;score.finish(new Settings());
    score.defaultSystemsLayout=1;score.systemsLayout=[1,1,1,1];const selection={tracks:[0],range:{first:0,last:2}};
    const without=renderPdfPages(score,selection,layout).map(page=>page.svg).join('');
    origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;
    const withPhrase=renderPdfPages(score,selection,layout).map(page=>page.svg).join('');
    const curves=(svg:string)=>(svg.match(/<path\b[^>]*d="[^"]*[CQ][^"]*"/g)??[]).length;
    expect(curves(withPhrase)).toBeGreaterThan(curves(without));expect(destination.slurOrigin).toBe(origin);expect(origin.slurDestination).toBe(destination);
  });
});
