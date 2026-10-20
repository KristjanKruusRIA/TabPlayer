// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { strToU8,zipSync } from 'fflate';
import { buildPlaybackPlan } from '../audio/plan';
import { exportMusicXml } from '../export/musicxml';
import { loadInterchangeScore } from './gp';
import { applyMusicXmlAlternateStaves } from './musicxml-alternate-staves';

const settings=new Settings();
type Note={step:string;octave:number;string:number;fret:number;tie?:'start'|'stop'};
// MuseScore-style notation + TAB guitar: staff 1 notation (voice 1), staff 2 TAB
// (voice 5) marked alternate; written an octave above sounding. Ties are numbered:
// alphaTab 1.8.4 cannot pair unnumbered ties under <transpose>, a separate defect.
const music:Note[]=[{step:'E',octave:3,string:6,fret:0},{step:'B',octave:3,string:5,fret:2},{step:'E',octave:4,string:4,fret:2,tie:'start'},{step:'E',octave:4,string:4,fret:2,tie:'stop'}];
const tuning=[['E',2],['A',2],['D',3],['G',3],['B',3],['E',4]].map(([step,octave],index)=>`<staff-tuning line="${index+1}"><tuning-step>${step}</tuning-step><tuning-octave>${octave}</tuning-octave></staff-tuning>`).join('');
function musicXml({alternate=true,tab=music,extra=''}:{alternate?:boolean;tab?:Note[];extra?:string}={}){
  const note=(value:Note,staff:number,voice:number)=>{
    const tie=value.tie?`<tie type="${value.tie}"/>`:'',tied=value.tie?`<tied type="${value.tie}" number="1"/>`:'';
    const technical=staff===2?`<technical><string>${value.string}</string><fret>${value.fret}</fret></technical>`:'';
    return `<note><pitch><step>${value.step}</step><octave>${value.octave}</octave></pitch><duration>1</duration>${tie}<voice>${voice}</voice><type>quarter</type><staff>${staff}</staff>${tied||technical?`<notations>${tied}${staff===2?extra:''}${technical}</notations>`:''}</note>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2">${alternate?'<staff-type>alternate</staff-type>':''}<staff-lines>6</staff-lines>${tuning}</staff-details><transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose></attributes>${music.map(value=>note(value,1,1)).join('')}<backup><duration>4</duration></backup>${tab.map(value=>note(value,2,5)).join('')}</measure></part></score-partwise>`;
}
const notesOf=(staff:model.Staff)=>staff.bars.flatMap(bar=>bar.voices.filter(voice=>!voice.isEmpty).flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>[note.realValue,note.isStringed?`${note.string}/${note.fret}`:null,note.isTieDestination,beat.displayStart]))));
const keys=(score:model.Score)=>buildPlaybackPlan(score,1).notes.map(note=>[note.startTick,note.key]);

describe('MusicXML alternate TAB staves',()=>{
  it('folds an alternate TAB staff into one staff shown both ways',()=>{
    const score=loadInterchangeScore(strToU8(musicXml()),settings),staff=score.tracks[0].staves[0];
    expect(score.tracks[0].staves.length).toBe(1);
    expect([staff.showStandardNotation,staff.showTablature]).toEqual([true,true]);
    expect(staff.stringTuning.tunings).toEqual([64,59,55,50,45,40]);
    expect(staff.bars[0].clef).toBe(model.Clef.G2);expect(staff.bars[0].clefOttava).toBe(model.Ottavia._8vb);
    // Sounding E2, B2, E3 tied: string/fret from the TAB staff, one attack per note.
    expect(notesOf(staff)).toEqual([[40,'1/0',false,0],[47,'2/2',false,960],[52,'3/2',false,1920],[52,'3/2',true,2880]]);
    expect(keys(score)).toEqual([[0,40],[960,47],[1920,52]]);
  });

  it('reproduces the doubled stock import as the negative control',()=>{
    const score=loadInterchangeScore(strToU8(musicXml({alternate:false})),settings);
    expect(score.tracks[0].staves.length).toBe(2);
    expect(keys(score)).toEqual([[0,40],[0,40],[960,47],[960,47],[1920,52],[1920,52]]);
  });

  it('reloads its own two-staff export as one staff',()=>{
    const source=loadInterchangeScore(strToU8(musicXml()),settings);
    const back=loadInterchangeScore(exportMusicXml(source,{tracks:[0],range:null}),settings);
    expect(back.tracks[0].staves.length).toBe(1);
    expect(notesOf(back.tracks[0].staves[0])).toEqual(notesOf(source.tracks[0].staves[0]));
    expect(keys(back)).toEqual(keys(source));
  });

  it.each([
    ['a different TAB note',musicXml({tab:music.map((value,index)=>index===1?{...value,fret:3,step:'C',octave:4}:value)})],
    ['an articulation only on the TAB staff',musicXml({extra:'<articulations><staccato/></articulations>'})],
    ['a missing TAB note',musicXml({tab:music.slice(0,3).concat([{step:'E',octave:4,string:4,fret:2}]).map((value,index)=>index===3?{...value,tie:undefined}:value)})],
  ])('keeps both staves for %s',(_name,text)=>{
    expect(loadInterchangeScore(strToU8(text),settings).tracks[0].staves.length).toBe(2);
  });

  it('returns the same score for non-MusicXML and GP inputs',()=>{
    for(const bytes of [new Uint8Array([1,2,3]),zipSync({'Content/score.gpif':strToU8('<GPIF/>')})]){
      const score=new model.Score();expect(applyMusicXmlAlternateStaves(score,bytes,settings)).toBe(score);
    }
  });
});
