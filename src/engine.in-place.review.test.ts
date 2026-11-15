import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { importer, model, Settings } from '@coderline/alphatab';
import { buildDocument, canEditInPlace, checkEditInPlace, editInPlace, exportGp, verifyEditInPlace, type BuiltDocument } from './engine';
import { blankProject, projectCommands, type EditCommand, type Project } from './project';

const B=String.fromCharCode(92),N=String.fromCharCode(10);
export const texProject=(...lines:string[]):Project=>{
  const imp=new importer.AlphaTexImporter();imp.initFromString(lines.join(N),new Settings());
  const bytes=exportGp(imp.readScore());
  return {...blankProject(),base:{kind:'file',filename:'fixture.gp',bytesBase64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}};
};
const header=[`${B}title "T"`,`${B}tempo 100`,`${B}track "Lead"`,`${B}staff {tabs}`,`${B}instrument 25`,`${B}tuning (e4 b3 g3 d3 a2 e2)`];
const at=(bar:number,beat:number,extra:Partial<{track:number;staff:number;voice:number}>={})=>({track:0,staff:0,bar,voice:0,beat,...extra});

/** Applies the edits one after another the way the controller does (in place where allowed, else rebuilt) and, after each, compares with a full rebuild. */
function chain(project:Project,edits:EditCommand[]) {
  let built=buildDocument(project);const used:boolean[]=[];
  for(const [index,edit] of edits.entries()) {
    const next:Project={...project,edits:[...project.edits,edit]};
    if(canEditInPlace(built,edit)){
      checkEditInPlace(built,edit,projectCommands(project).length);built=editInPlace(built,edit,projectCommands(project).length);used.push(true);
      expect(verifyEditInPlace(next,built),`after edit ${index} ${JSON.stringify(edit)}`).toBeNull();
    } else {built=buildDocument(next);used.push(false);}
    project=next;
  }
  return {built,project,used};
}

const beats0=(d:BuiltDocument)=>d.score.tracks[0].staves[0].bars.flatMap(b=>b.voices[0].beats.map(e=>e.id)).join(',');
const notes0=(d:BuiltDocument)=>d.score.tracks[0].staves[0].bars.flatMap(b=>b.voices[0].beats.flatMap(e=>e.notes.map(n=>n.id))).join(',');
describe('sequences traced in review',()=>{
  it('1. a hammer-on keeps its destination when a note is written between its two notes',()=>{
    const project=texProject(...header,`:8 3.3{h} 5.3 7.3 5.3 3.3 3.3 3.3 r |`,`:4 3.3 3.3 3.3 3.3 |`);
    const {built}=chain(project,[
      {type:'deleteBeat',target:at(0,7)},
      {type:'insertBeat',target:at(0,1),duration:8,dots:0},
      // The string of the two hammered notes (alphaTex counts strings from the top, the model from the bottom).
      {type:'setNote',target:at(0,1),string:buildDocument(project).score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].string,fret:4},
    ]);
    const first=built.score.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(first[0].notes[0].hammerPullDestination).toBe(first[2].notes[0]);
    expect(first[1].notes[0].hammerPullOrigin).toBeNull();
  });
  it('2. an edit in a pickup bar moves the bars after it, so it is rebuilt',()=>{
    const project=texProject(...header,`${B}ac :4 3.3 |`,`:4 5.3 5.3 5.3 5.3 |`,`:4 3.3 3.3 3.3 3.3 |`);
    const built=buildDocument(project);
    expect(built.score.masterBars[0].isAnacrusis,'the fixture has a pickup bar').toBe(true);
    const edit:EditCommand={type:'insertBeat',target:at(0,1),duration:4,dots:0};
    // Either the edit is rebuilt, or what is done in place equals the rebuild.
    if(canEditInPlace(built,edit)){
      const next=editInPlace(built,edit,0);
      expect(verifyEditInPlace({...project,edits:[edit]},next)).toBeNull();
    }
    expect(canEditInPlace(built,edit)).toBe(false);
  });
  it('2b. a bar with a fermata, and a voice with one, are rebuilt',()=>{
    const project=texProject(...header,`:4 3.3{fermata medium} 5.3 5.3 r |`,`:4 3.3 3.3 3.3 3.3 |`);
    const built=buildDocument(project);
    expect(canEditInPlace(built,{type:'setNote',target:at(0,1),string:2,fret:2})).toBe(false);
    expect(canEditInPlace(built,{type:'setNote',target:at(1,1),string:2,fret:2})).toBe(true);
  });
  it('3. new notes and beats never take an id a note or beat of the score already has, after another score reset the counters',()=>{
    const project=texProject(...header,`:8 3.3 5.3 7.3 5.3 3.3 3.3 3.3 r |`,`:4 3.3 3.3 3.3 3.3 |`);
    let built=buildDocument(project);
    // Another score in another tab is opened: every importer start counts ids from zero again, and ends with its own count.
    texProject(...header,`:4 3.3 5.3 7.3 5.3 |`,`:4 3.3 5.3 7.3 5.3 |`);
    // ...and it left the counters inside the range of ids the first score holds.
    const counters=model as unknown as {Beat:{_globalBeatId:number};Note:{globalNoteId:number};Bar:{_globalBarId:number};Voice:{_globalVoiceId:number}};
    const live=(text:string)=>{const values=text.split(',').map(Number).sort((a,b)=>a-b);return values[values.length>>1];};
    counters.Beat._globalBeatId=live(beats0(built));counters.Note.globalNoteId=live(notes0(built));counters.Bar._globalBarId=1;counters.Voice._globalVoiceId=1;
    const edits:EditCommand[]=[{type:'deleteBeat',target:at(0,7)},{type:'insertBeat',target:at(0,1),duration:8,dots:0},{type:'setNote',target:at(0,1),string:3,fret:4}];
    let current=project;
    for(const edit of edits){built=editInPlace(built,edit,0);current={...current,edits:[...current.edits,edit]};}
    const ids=(items:{id:number}[])=>new Set(items.map(item=>item.id)).size===items.length;
    const notes:model.Note[]=[],beats:model.Beat[]=[],bars:model.Bar[]=[],voices:model.Voice[]=[];
    for(const track of built.score.tracks)for(const staff of track.staves)for(const bar of staff.bars){bars.push(bar);for(const voice of bar.voices){voices.push(voice);for(const beat of voice.beats){beats.push(beat);notes.push(...beat.notes);}}}
    expect(ids(notes),'note ids').toBe(true);expect(ids(beats),'beat ids').toBe(true);expect(ids(bars),'bar ids').toBe(true);expect(ids(voices),'voice ids').toBe(true);
    expect(verifyEditInPlace(current,built)).toBeNull();
  });
  it('3b. the verifier reports a score that holds two notes with one id',()=>{
    const built=buildDocument(texProject(...header,`:4 3.3 5.3 7.3 5.3 |`));
    const notes=built.score.tracks[0].staves[0].bars[0].voices[0].beats.map(beat=>beat.notes[0]);
    notes[1].id=notes[0].id;
    expect(String(verifyEditInPlace(texProject(...header,`:4 3.3 5.3 7.3 5.3 |`),built))).toMatch(/duplicate/i);
  });
  it('4. music written for the first time in a second voice leaves the staff with the voices a rebuild gives it',()=>{
    const project:Project={...blankProject(),base:{kind:'blank',title:'B',artist:'',tempo:120,tuning:[64,59,55,50,45,40],measureCount:6},edits:[{type:'addVoice',track:0,staff:0},{type:'addVoice',track:0,staff:0},{type:'setNote',target:at(3,0,{voice:2}),string:2,fret:3}]};
    const {built,used}=chain(project,[
      {type:'setNote',target:at(1,0,{voice:1}),string:2,fret:5},
      {type:'setNote',target:at(0,0,{voice:1}),string:3,fret:7},
      {type:'setRest',target:at(1,0,{voice:1})},
    ]);
    expect(used.every(Boolean),'the edits to a second voice are applied in place').toBe(true);
    expect([...(built.score.tracks[0].staves[0] as unknown as {_filledVoices:Set<number>})._filledVoices]).toEqual([0,1,2]);
  });
  it('5. rests beside palm-muted or let-ring notes are rebuilt, because finishing hands the marks on from whatever they were before',()=>{
    const project=texProject(...header,`:8 3.3{pm} 3.3{pm} 3.3{pm} r 3.3{pm} r r 3.3 |`,`:8 3.3{lr} 3.3 r 3.3 r r r 3.3 |`,`:4 3.3 3.3 3.3 3.3 |`);
    const built=buildDocument(project);
    const beside={type:'setRest' as const,target:at(0,2)};
    expect(canEditInPlace(built,beside),'beside palm mute').toBe(false);
    expect(canEditInPlace(built,{type:'setRest',target:at(1,1)}),'beside let ring').toBe(false);
    expect(canEditInPlace(built,{type:'removeNote',target:at(0,4),string:3}),'removing the note a palm mute run ends on').toBe(false);
    // A note that stays a note, and a bar with no marks, are still applied in place.
    expect(canEditInPlace(built,{type:'setNote',target:at(0,0),string:4,fret:5})).toBe(true);
    expect(canEditInPlace(built,{type:'setRest',target:at(2,1)})).toBe(true);
    const run=chain(project,[{type:'setRest',target:at(0,2)},{type:'setNote',target:at(0,3),string:4,fret:2},{type:'removeNote',target:at(0,4),string:4},{type:'setNote',target:at(0,2),string:4,fret:2}]);
    expect(verifyEditInPlace(run.project,run.built)).toBeNull();
  });
});
