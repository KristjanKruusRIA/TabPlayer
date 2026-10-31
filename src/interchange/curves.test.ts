// @vitest-environment jsdom
import { afterEach,describe,expect,it,vi } from 'vitest';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { strFromU8,strToU8,unzipSync,zipSync } from 'fflate';
import { music } from '../editor/fixtures';
import { exportGpInterchange,loadInterchangeScore } from './gp';
import { writeStylesheetTimeSignatures } from './stylesheet';
import { scoreFromJson } from '../model-clone';
import { buildPlaybackPlan } from '../audio/plan';
import { setBanjoDrone } from '../editor/banjo-drone';

const settings=new Settings();
afterEach(()=>vi.restoreAllMocks());
const points=(...values:number[][])=>values.map(([offset,value])=>new model.BendPoint(offset,value));
function bend(note:model.Note,type:model.BendType,style:model.BendStyle,...values:number[][]) {
  note.bendType=type;note.bendStyle=style;for(const point of points(...values))note.addBendPoint(point);
}
function whammy(beat:model.Beat,type:model.WhammyType,style:model.BendStyle,...values:number[][]) {
  beat.whammyBarType=type;beat.whammyStyle=style;for(const point of points(...values))beat.addWhammyBarPoint(point);
}
const beatsOf=(score:model.Score,bar:number,voice=0,track=0)=>score.tracks[track].staves[0].bars[bar].voices[voice].beats;
function link(from:model.Note,to:model.Note) {from.slurDestination=to;to.slurOrigin=from;to.isSlurDestination=true;}
/** Bends of every length and style, fractional quarter tones, three whammy shapes and a slur that skips a beat and changes string. */
function authored() {
  const score=music(),bar0=beatsOf(score,0),bar1=beatsOf(score,1);
  bar0[2].notes[0].string=4;bar0[2].notes[0].fret=7;bar0[1].notes[0].string=5;bar0[1].notes[0].fret=5;
  bend(bar0[1].notes[0],model.BendType.Custom,model.BendStyle.Fast,[0,0],[10,2],[20,4],[30,4],[45,1.5],[60,0]);
  bend(bar0[3].notes[0],model.BendType.PrebendRelease,model.BendStyle.Gradual,[0,4],[30,0],[60,3]);
  link(bar0[0].notes[0],bar0[2].notes[0]);
  whammy(bar1[0],model.WhammyType.Custom,model.BendStyle.Gradual,[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]);
  whammy(bar1[1],model.WhammyType.Hold,model.BendStyle.Fast,[0,-2],[60,-2]);
  whammy(bar1[2],model.WhammyType.Dip,model.BendStyle.Default,[0,0],[20,-4],[40,0],[60,0]);
  score.finish(settings);return score;
}
const pointsOf=(list:model.BendPoint[]|null)=>list?.map(point=>[point.offset,point.value])??null;
/** Everything these rows are about, as plain data. */
function state(score:model.Score) {
  return score.tracks.map(track=>track.staves.map(staff=>staff.bars.map(bar=>bar.voices.map(voice=>voice.beats.map(beat=>({
    whammy:beat.hasWhammyBar?[beat.whammyBarType,beat.whammyStyle,pointsOf(beat.whammyBarPoints)]:null,
    notes:beat.notes.map(note=>({
      string:note.string,fret:note.fret,bend:note.hasBend?[note.bendType,note.bendStyle,pointsOf(note.bendPoints)]:null,
      slur:note.slurDestination?[note.slurDestination.beat.voice.bar.index,note.slurDestination.beat.index,note.slurDestination.string]:null,
      slurIn:!!note.slurOrigin&&note.isSlurDestination,
    })),
  }))))));
}
const roundTrip=(score:model.Score)=>loadInterchangeScore(exportGpInterchange(score,settings),settings);
function edit(bytes:Uint8Array,change:(xml:string)=>string) {
  const entries=unzipSync(bytes);entries['Content/score.gpif']=strToU8(change(strFromU8(entries['Content/score.gpif'])));return zipSync(entries);
}
const warnings=()=>vi.spyOn(console,'warn').mockImplementation(()=>undefined);

describe('GP curves and slurs',()=>{
  it('records what alphaTab alone cannot carry, which is why the property exists',()=>{
    const stock=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(authored(),settings),settings),before=state(authored()),after=state(stock);
    expect(after[0][0][0][0][1].notes[0].bend).toBeNull();// six points: the writer omits the bend
    expect(after[0][0][0][0][0].notes[0].slur).toBeNull();// no note-to-note slur exists in GPIF
    expect(after[0][0][1][0][0].whammy).not.toEqual(before[0][0][1][0][0].whammy);// five points become four, -5.5 becomes -3 and the style goes
    expect(after[0][0][1][0][1].whammy).not.toEqual(before[0][0][1][0][1].whammy);// the two-point hold becomes four points and the style is gone
  });
  it('round trips long bends, whammy bars, quarter tones, styles and a cross-string slur without loss',()=>{
    const score=authored(),expected=state(score),loaded=roundTrip(score);
    expect(state(loaded)).toEqual(expected);
    // A second pass is the same: nothing drifts once restored.
    expect(state(roundTrip(loaded))).toEqual(expected);
    expect(expected[0][0][0][0][1].notes[0].bend).toEqual([model.BendType.Custom,model.BendStyle.Fast,[[0,0],[10,2],[20,4],[30,4],[45,1.5],[60,0]]]);
    expect(expected[0][0][1][0][0].whammy).toEqual([model.WhammyType.Custom,model.BendStyle.Gradual,[[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]]]);
  });
  it('keeps maxima and continuation consistent with the restored curves',()=>{
    const loaded=roundTrip(authored()),note=beatsOf(loaded,0)[1].notes[0],beat=beatsOf(loaded,1)[0];
    expect(note.maxBendPoint?.value).toBe(4);
    expect(beat.maxWhammyPoint?.value).toBe(1.5);expect(beat.minWhammyPoint?.value).toBe(-5.5);
    expect(beatsOf(loaded,1)[1].isContinuedWhammy).toBe(true);
  });
  it('adds one staff property to a file that otherwise reads as before',()=>{
    const xml=strFromU8(unzipSync(exportGpInterchange(authored(),settings))['Content/score.gpif']);
    expect(xml.match(/name="TabPlayerCurves"/g)).toHaveLength(1);expect(xml).toContain('<Whammy destinationOffset=');
  });
  it('writes no property for a score without curves or slurs',()=>{
    const xml=strFromU8(unzipSync(exportGpInterchange(music(),settings))['Content/score.gpif']);
    expect(xml).not.toContain('TabPlayerCurves');
  });
  it('restores music in a second voice beside an empty first voice',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    const second=new model.Voice();for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=3;note.fret=2;beat.addNote(note);second.addBeat(beat);}
    staff.bars[0].addVoice(second);staff.bars[0].voices[0].beats.forEach(beat=>{beat.notes=[];beat.isEmpty=true;});
    for(const bar of staff.bars.slice(1)){const quiet=new model.Voice(),beat=new model.Beat();beat.duration=4;beat.isEmpty=true;quiet.addBeat(beat);bar.addVoice(quiet);}
    bend(second.beats[1].notes[0],model.BendType.Bend,model.BendStyle.Fast,[0,0],[15,1],[30,2],[45,3],[60,4]);
    whammy(second.beats[2],model.WhammyType.Dive,model.BendStyle.Gradual,[0,0],[30,-1.5],[60,-3]);link(second.beats[0].notes[0],second.beats[3].notes[0]);
    score.finish(settings);
    const loaded=roundTrip(score),voice=loaded.tracks[0].staves[0].bars[0].voices[1].beats;
    expect(voice[1].notes[0].bendPoints).toHaveLength(5);expect(voice[2].whammyBarPoints?.[1].value).toBe(-1.5);
    expect(voice[0].notes[0].slurDestination).toBe(voice[3].notes[0]);expect(loaded.tracks[0].staves[0].bars[0].voices[0].isEmpty).toBe(true);
  });
  it('keeps curves on the right track',()=>{
    const score=authored(),other=model.JsonConverter.jsonToScore(model.JsonConverter.scoreToJson(music()),settings).tracks[0];other.name='Second';score.addTrack(other);
    whammy(beatsOf(score,2,0,1)[0],model.WhammyType.Dive,model.BendStyle.Fast,[0,0],[20,-1],[40,-2],[50,-2.5],[60,-3]);score.finish(settings);
    const loaded=roundTrip(score);
    expect(state(loaded)).toEqual(state(score));expect(beatsOf(loaded,2,0,1)[0].whammyBarPoints).toHaveLength(5);expect(beatsOf(loaded,2,0,0)[0].hasWhammyBar).toBe(false);
  });
  it('re-derives a tied continuation from a bend alphaTab cannot write',()=>{
    const score=music(),beats=beatsOf(score,0),origin=beats[0].notes[0],destination=beats[1].notes[0];
    bend(origin,model.BendType.Bend,model.BendStyle.Default,[0,0],[15,2],[30,3],[45,3.5],[60,4]);
    origin.tieDestination=destination;destination.tieOrigin=origin;destination.isTieDestination=true;score.finish(settings);
    const loaded=roundTrip(score),a=beatsOf(loaded,0)[0].notes[0],b=beatsOf(loaded,0)[1].notes[0];
    expect(a.bendPoints).toHaveLength(5);expect(b.bendOrigin).toBe(a);
  });
  it('does not override ordinary GPIF fields that were edited after the property was written',()=>{
    warnings();
    // The first whammy alphaTab wrote is the two-point hold: its destination is edited, the longer curves are not.
    const loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replace(/destinationValue="-?[\d.]+"/,'destinationValue="-300"')),settings),hold=beatsOf(loaded,1)[1];
    expect(hold.whammyBarPoints).toHaveLength(4);expect(hold.whammyBarPoints?.at(-1)?.value).toBe(-12);
    expect(pointsOf(beatsOf(loaded,1)[0].whammyBarPoints)).toEqual([[0,0],[10,-3],[25,-5.5],[40,-0.5],[60,1.5]]);
    expect(beatsOf(loaded,0)[1].notes[0].bendPoints).toHaveLength(6);
  });
  it('skips a slur whose notes were edited, and a malformed item, without refusing the file',()=>{
    const warn=warnings();
    const loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replace(/<Slur ([^>]*?)fret="3"/,'<Slur $1fret="9"').replace(/(<Whammy [^>]*><Point offset=")[^"]+/,'$1oops')),settings);
    expect(beatsOf(loaded,0)[0].notes[0].slurDestination).toBeNull();
    expect(beatsOf(loaded,1)[0].hasWhammyBar).toBe(false);
    expect(beatsOf(loaded,0)[1].notes[0].bendPoints).toHaveLength(6);
    expect(pointsOf(beatsOf(loaded,1)[2].whammyBarPoints)).toEqual([[0,0],[20,-4],[40,0],[60,0]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed curve'));
  });
  it('ignores an item that refers to music the file no longer holds',()=>{
    const warn=warnings(),loaded=loadInterchangeScore(edit(exportGpInterchange(authored(),settings),xml=>xml.replaceAll('<Bend bar="0"','<Bend bar="40"')),settings);
    expect(beatsOf(loaded,0)[1].notes[0].hasBend).toBe(false);expect(warn).toHaveBeenCalled();
  });
});

/** Editing the GPIF as a document, so a hostile file can be forged with every id and note it must agree with. */
function editDoc(bytes:Uint8Array,change:(doc:Document)=>void) {
  return edit(bytes,xml=>{const doc=new DOMParser().parseFromString(xml,'application/xml');change(doc);return new XMLSerializer().serializeToString(doc);});
}
const listOf=(node:Element|undefined,name:string)=>(node?.querySelector(`:scope > ${name}`)?.textContent??'').trim().split(/\s+/);
const nodeById=(doc:Document,path:string,id:string)=>[...doc.querySelectorAll(path)].find(item=>item.getAttribute('id')===id);
function idAt(doc:Document,bar:number,voice:number,beat:number,note:number) {
  const barId=listOf(doc.querySelectorAll('GPIF > MasterBars > MasterBar')[bar],'Bars')[0],voiceId=listOf(nodeById(doc,'GPIF > Bars > Bar',barId),'Voices')[voice];
  const beatId=listOf(nodeById(doc,'GPIF > Voices > Voice',voiceId),'Beats')[beat];
  return listOf(nodeById(doc,'GPIF > Beats > Beat',beatId),'Notes')[note];
}
const sidecar=(doc:Document,name:string)=>[...doc.querySelectorAll(`Property[name="TabPlayerCurves"] > Items > ${name}`)];
type Place=[number,number,number,number];
/** Points a slur item at two notes of the authored model, ids and frets included, so only the rule can refuse it. */
function aim(doc:Document,item:Element,score:model.Score,from:Place,to:Place) {
  const note=(place:Place)=>score.tracks[0].staves[0].bars[place[0]].voices[place[1]].beats[place[2]].notes[place[3]];
  for(const [prefix,place] of [['',from],['to',to]] as const){
    for(const [name,value] of [['bar',place[0]],['voice',place[1]],['beat',place[2]],['note',place[3]]] as const)item.setAttribute(prefix+name,String(value));
    item.setAttribute(prefix?'toId':'id',idAt(doc,...place));
    item.setAttribute(prefix?'toStr':'string',String(note(place).string));item.setAttribute(prefix?'toFret':'fret',String(note(place).fret));
  }
}
function twoVoices() {
  const score=music(),staff=score.tracks[0].staves[0],second=new model.Voice();
  for(let index=0;index<4;index++){const beat=new model.Beat();beat.duration=4;beat.isEmpty=false;const note=new model.Note();note.string=3;note.fret=2;beat.addNote(note);second.addBeat(beat);}
  staff.bars[0].addVoice(second);
  for(const bar of staff.bars.slice(1)){const quiet=new model.Voice(),beat=new model.Beat();beat.duration=4;beat.isEmpty=true;quiet.addBeat(beat);bar.addVoice(quiet);}
  link(staff.bars[0].voices[0].beats[0].notes[0],staff.bars[0].voices[0].beats[2].notes[0]);score.finish(settings);return score;
}
const allNotes=(score:model.Score)=>score.tracks.flatMap(track=>track.staves.flatMap(staff=>staff.bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes)))));
/** What the engine and the playback plan do with a freshly loaded score, which a hostile slur or curve used to break. */
function usable(score:model.Score) {
  expect(()=>scoreFromJson(model.JsonConverter.scoreToJson(score),settings)).not.toThrow();
  expect(()=>buildPlaybackPlan(score,1)).not.toThrow();
}

describe('hostile slurs',()=>{
  const cases:[string,Place,Place][]=[
    ['a backward slur in one voice',[0,0,2,0],[0,0,0,0]],
    ['a slur across voices',[0,0,1,0],[0,1,2,0]],
    ['a slur to its own note',[0,0,1,0],[0,0,1,0]],
    ['a slur on the same beat of another voice',[0,0,3,0],[0,1,3,0]],
    ['a slur back into an earlier bar',[1,0,0,0],[0,0,3,0]],
  ];
  it.each(cases)('keeps %s out of the score',(name,from,to)=>{
    const score=twoVoices();
    // The forged slur sits beside the genuine one from beat 0 to beat 2, so the pair closes a cycle where the forged one runs back.
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{
      const [valid]=sidecar(doc,'Slur'),copy=valid.cloneNode(true) as Element;aim(doc,copy,score,from,to);valid.parentNode!.append(copy);
    });
    const warn=warnings(),loaded=loadInterchangeScore(bytes,settings),linked=allNotes(loaded).filter(note=>note.slurDestination);
    expect(linked).toHaveLength(1);expect(linked[0].beat.index).toBe(0);expect(linked[0].slurDestination?.beat.index).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slur'));
    usable(loaded);
  });
  it('keeps a backward slur that would close a cycle out of the score',()=>{
    const score=twoVoices(),warn=warnings();
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{
      const [valid]=sidecar(doc,'Slur'),copy=valid.cloneNode(true) as Element;aim(doc,copy,score,[0,0,2,0],[0,0,0,0]);valid.parentNode!.append(copy);
    });
    const loaded=loadInterchangeScore(bytes,settings),first=beatsOf(loaded,0)[0].notes[0],third=beatsOf(loaded,0)[2].notes[0];
    expect(first.slurDestination).toBe(third);expect(third.slurDestination).toBeNull();expect(first.slurOrigin).toBeNull();expect(warn).toHaveBeenCalled();usable(loaded);
  });
});

describe('stale curves and slurs',()=>{
  const bendNote=(score:model.Score)=>beatsOf(score,0)[1].notes[0];
  it('does not apply a long curve to a note whose fret was changed',()=>{
    const score=authored(),warn=warnings();
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{
      nodeById(doc,'GPIF > Notes > Note',String(bendNote(score).id))!.querySelector('Property[name="Fret"] > Fret')!.textContent='9';
    });
    const loaded=loadInterchangeScore(bytes,settings);
    expect(bendNote(loaded).fret).toBe(9);expect(bendNote(loaded).hasBend).toBe(false);expect(warn).toHaveBeenCalled();usable(loaded);
  });
  it('does not apply curves or slurs after two beats were swapped',()=>{
    const score=authored(),warn=warnings();
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{
      const bar=nodeById(doc,'GPIF > Bars > Bar',listOf(doc.querySelectorAll('GPIF > MasterBars > MasterBar')[0],'Bars')[0])!;
      const voice=nodeById(doc,'GPIF > Voices > Voice',listOf(bar,'Voices')[0])!,ids=listOf(voice,'Beats');
      [ids[0],ids[1]]=[ids[1],ids[0]];voice.querySelector(':scope > Beats')!.textContent=ids.join(' ');
    });
    const loaded=loadInterchangeScore(bytes,settings);
    expect(allNotes(loaded).some(note=>note.bendPoints?.length===6)).toBe(false);
    expect(beatsOf(loaded,0)[0].notes[0].slurDestination).toBeNull();expect(warn).toHaveBeenCalled();usable(loaded);
  });
  it('does not apply anything after a bar was inserted before the music',()=>{
    const score=authored(),warn=warnings();
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{
      const masters=doc.querySelectorAll('GPIF > MasterBars > MasterBar'),barId=listOf(masters[3],'Bars')[0];
      const bar=nodeById(doc,'GPIF > Bars > Bar',barId)!,voice=nodeById(doc,'GPIF > Voices > Voice',listOf(bar,'Voices')[0])!,beat=nodeById(doc,'GPIF > Beats > Beat',listOf(voice,'Beats')[0])!,note=nodeById(doc,'GPIF > Notes > Note',listOf(beat,'Notes')[0])!;
      const copies=[bar,voice,beat,note].map(node=>{const copy=node.cloneNode(true) as Element;copy.setAttribute('id','9000');node.after(copy);return copy;});
      copies[0].querySelector(':scope > Voices')!.textContent='9000';copies[1].querySelector(':scope > Beats')!.textContent='9000';copies[2].querySelector(':scope > Notes')!.textContent='9000';
      const master=masters[0].cloneNode(true) as Element;master.querySelector(':scope > Bars')!.textContent='9000';masters[0].before(master);
    });
    const loaded=loadInterchangeScore(bytes,settings);
    expect(loaded.tracks[0].staves[0].bars).toHaveLength(5);
    expect(allNotes(loaded).some(note=>note.bendPoints?.length===6||note.slurDestination)).toBe(false);
    expect(loaded.tracks[0].staves[0].bars.some(bar=>bar.voices[0].beats.some(beat=>beat.whammyBarPoints?.length===5))).toBe(false);
    expect(warn).toHaveBeenCalled();usable(loaded);
  });
  it('does not apply a long curve whose recorded id belongs to another note',()=>{
    const score=authored(),warn=warnings();
    const bytes=editDoc(exportGpInterchange(score,settings),doc=>{sidecar(doc,'Bend')[0].setAttribute('id',String(beatsOf(score,0)[3].notes[0].id));});
    expect(bendNote(loadInterchangeScore(bytes,settings)).hasBend).toBe(false);expect(warn).toHaveBeenCalled();
  });
});

describe('curve shape and range',()=>{
  const longBend=(doc:Document)=>sidecar(doc,'Bend').find(item=>item.querySelectorAll('Point').length===6)!;
  const points=(item:Element)=>item.querySelectorAll('Point');
  const refuse:[string,(item:Element)=>void][]=[
    ['a single point',item=>[...points(item)].slice(1).forEach(point=>point.remove())],
    ['unsorted offsets',item=>points(item)[2].setAttribute('offset','5')],
    ['an end past 60',item=>points(item)[5].setAttribute('offset','61')],
    ['a negative offset',item=>points(item)[0].setAttribute('offset','-1')],
    ['a bend release with three points',item=>{item.setAttribute('type',String(model.BendType.BendRelease));points(item)[2].remove();points(item)[2].remove();points(item)[2].remove();}],
    ['a negative bend value',item=>points(item)[1].setAttribute('value','-1')],
    ['a value of a million',item=>points(item)[1].setAttribute('value','1000000')],
    ['a value of 1e300',item=>points(item)[1].setAttribute('value','1e300')],
    ['a value just past the range',item=>points(item)[1].setAttribute('value','32.5')],
    ['a value that is not a number',item=>points(item)[1].setAttribute('value','oops')],
    ['no curve type',item=>item.setAttribute('type','0')],
    ['an unknown style',item=>item.setAttribute('style','9')],
  ];
  it.each(refuse)('refuses %s',(name,change)=>{
    const warn=warnings(),loaded=loadInterchangeScore(editDoc(exportGpInterchange(authored(),settings),doc=>change(longBend(doc))),settings);
    expect(beatsOf(loaded,0)[1].notes[0].hasBend).toBe(false);expect(warn).toHaveBeenCalled();usable(loaded);
  });
  it('refuses a whammy value past the range in either direction',()=>{
    for(const value of ['-33','33','-1e300']){
      const warn=warnings(),loaded=loadInterchangeScore(editDoc(exportGpInterchange(authored(),settings),doc=>points(sidecar(doc,'Whammy')[0])[1].setAttribute('value',value)),settings);
      expect(beatsOf(loaded,1)[0].hasWhammyBar).toBe(false);expect(warn).toHaveBeenCalled();usable(loaded);
    }
  });
  it('accepts the extremes of the range and still plays',()=>{
    const score=music();
    bend(beatsOf(score,0)[1].notes[0],model.BendType.Custom,model.BendStyle.Default,[0,0],[20,32],[40,32],[60,0]);whammy(beatsOf(score,1)[0],model.WhammyType.Custom,model.BendStyle.Default,[0,-32],[30,32],[60,-32]);score.finish(settings);
    const loaded=roundTrip(score);expect(state(loaded)).toEqual(state(score));usable(loaded);
  });
  it('does not write a curve the reader would refuse, so a file never warns about itself',()=>{
    const score=music();bend(beatsOf(score,0)[1].notes[0],model.BendType.Custom,model.BendStyle.Default,[0,0],[30,1e6],[60,0]);score.finish(settings);
    expect(strFromU8(unzipSync(exportGpInterchange(score,settings))['Content/score.gpif'])).not.toContain('TabPlayerCurves');
  });
});

describe('files without curves or slurs',()=>{
  const normalized=(xml:string)=>new XMLSerializer().serializeToString(new DOMParser().parseFromString(xml,'application/xml'));
  it('write exactly the bytes they wrote before curves were carried',()=>{
    const score=music(),entries=unzipSync(new exporter.Gp7Exporter().export(score,settings));
    const baseline=zipSync(writeStylesheetTimeSignatures(score,entries),{mtime:new Date(1980,0,1)});
    expect(exportGpInterchange(score,settings)).toEqual(baseline);
  });
  it('differ from the plain alphaTab file only by the property and by the XML pass',()=>{
    const score=authored(),raw=strFromU8(unzipSync(new exporter.Gp7Exporter().export(score,settings))['Content/score.gpif']);
    const ours=new DOMParser().parseFromString(strFromU8(unzipSync(exportGpInterchange(score,settings))['Content/score.gpif']),'application/xml');
    // Known differences of the XML pass: an empty <Automations/> in each ChannelStrip, and elements such as an empty
    // <SystemsLayout></SystemsLayout> written as <SystemsLayout/>, which parsing both documents makes equal.
    ours.querySelectorAll('Property[name="TabPlayerCurves"]').forEach(node=>node.remove());
    ours.querySelectorAll('ChannelStrip > Automations').forEach(node=>{expect(node.childElementCount).toBe(0);node.remove();});
    expect(normalized(new XMLSerializer().serializeToString(ours))).toBe(normalized(raw));
  });
});

describe('curves the first version lost or broke',()=>{
  it('refuses a two-point whammy dip in the styles that read a third point, and carries a three-point one',()=>{
    for(const style of [model.BendStyle.Gradual,model.BendStyle.Fast]){
      const score=music();whammy(beatsOf(score,1)[2],model.WhammyType.Dip,style,[0,0],[30,-4],[60,0]);score.finish(settings);
      const loaded=roundTrip(score);expect(state(loaded)).toEqual(state(score));usable(loaded);
      const warn=warnings(),forged=loadInterchangeScore(editDoc(exportGpInterchange(score,settings),doc=>sidecar(doc,'Whammy')[0].querySelectorAll('Point')[1].remove()),settings);
      // The forged two-point dip is not applied: the ordinary fields stand, in the default style, and the plan builds.
      expect(beatsOf(forged,1)[2].whammyStyle).toBe(model.BendStyle.Default);expect(warn).toHaveBeenCalled();usable(forged);
    }
  });
  it('keeps the style of a bend release that Note.finish rewrites with a repeated offset',()=>{
    const score=music(),note=beatsOf(score,0)[1].notes[0];
    bend(note,model.BendType.Custom,model.BendStyle.Fast,[0,0],[30,4],[60,0]);score.finish(settings);
    expect(note.bendType).toBe(model.BendType.BendRelease);expect(pointsOf(note.bendPoints)).toEqual([[0,0],[30,4],[30,4],[60,0]]);
    const loaded=roundTrip(score);expect(state(loaded)).toEqual(state(score));expect(beatsOf(loaded,0)[1].notes[0].bendStyle).toBe(model.BendStyle.Fast);usable(loaded);
  });
  it('carries long curves with a repeated offset or an end short of 60',()=>{
    const score=music();
    bend(beatsOf(score,0)[1].notes[0],model.BendType.Custom,model.BendStyle.Fast,[0,0],[10,2],[10,3],[30,4],[50,0]);
    whammy(beatsOf(score,1)[0],model.WhammyType.Custom,model.BendStyle.Default,[0,0],[20,-2],[20,-3],[40,-1],[45,0]);score.finish(settings);
    const loaded=roundTrip(score);expect(state(loaded)).toEqual(state(score));usable(loaded);
  });
  it('stops the export instead of silently dropping a long curve it cannot carry',()=>{
    const score=music();
    bend(beatsOf(score,0)[1].notes[0],model.BendType.Custom,model.BendStyle.Default,[0,0],[10,2],[20,4],[40,40],[60,0]);score.finish(settings);
    expect(()=>exportGpInterchange(score,settings)).toThrow(/cannot keep the bend at track 1, bar 1, beat 2/);
  });
  it('keeps curves on banjo drone notes, which GPIF holds at their plain fret',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    staff.stringTuning.tunings=[62,59,55,50,67];
    for(const bar of staff.bars)for(const beat of bar.voices[0].beats){beat.notes[0].string=2;beat.notes[0].fret=3;}
    setBanjoDrone(staff,5);
    const beats=beatsOf(score,0);
    for(const [index,fret]of [[0,7],[2,9]]){beats[index].notes[0].string=1;beats[index].notes[0].fret=fret;}
    bend(beats[0].notes[0],model.BendType.Custom,model.BendStyle.Fast,[0,0],[10,2],[20,4],[30,4],[60,0]);
    whammy(beats[2],model.WhammyType.Custom,model.BendStyle.Gradual,[0,0],[10,-3],[25,-5],[40,-2],[60,1]);
    link(beats[0].notes[0],beats[2].notes[0]);score.finish(settings);
    const loaded=roundTrip(score),read=beatsOf(loaded,0);
    // GPIF and the score read back hold semitones above the open string; the drone is set again by the project.
    expect(read[0].notes[0].fret).toBe(2);expect(read[2].notes[0].fret).toBe(4);
    expect(pointsOf(read[0].notes[0].bendPoints)).toEqual([[0,0],[10,2],[20,4],[30,4],[60,0]]);expect(read[0].notes[0].bendStyle).toBe(model.BendStyle.Fast);
    expect(pointsOf(read[2].whammyBarPoints)).toEqual([[0,0],[10,-3],[25,-5],[40,-2],[60,1]]);
    expect(read[0].notes[0].slurDestination).toBe(read[2].notes[0]);
  });
  it('keeps a beat whammy when only one of its notes sits on the drone string',()=>{
    const score=music(),staff=score.tracks[0].staves[0];
    staff.stringTuning.tunings=[62,59,55,50,67];
    for(const bar of staff.bars)for(const beat of bar.voices[0].beats){beat.notes[0].string=2;beat.notes[0].fret=3;}
    setBanjoDrone(staff,5);
    const beat=beatsOf(score,0)[1],drone=new model.Note();drone.string=1;drone.fret=8;beat.addNote(drone);
    whammy(beat,model.WhammyType.Custom,model.BendStyle.Default,[0,0],[10,-3],[25,-5],[40,-2],[60,1]);score.finish(settings);
    expect(beatsOf(roundTrip(score),0)[1].whammyBarPoints).toHaveLength(5);
  });
  it('does not apply an edited ordinary bend field over the property',()=>{
    const score=authored(),note=beatsOf(score,0)[3].notes[0],warn=warnings();
    const loaded=loadInterchangeScore(editDoc(exportGpInterchange(score,settings),doc=>{
      nodeById(doc,'GPIF > Notes > Note',String(note.id))!.querySelector('Property[name="BendDestinationValue"] > Float')!.textContent='50';
    }),settings),read=beatsOf(loaded,0)[3].notes[0];
    // The file now says a destination of 2, in the style alphaTab reads; the property's older 3 and Gradual are not restored.
    expect(read.bendPoints?.at(-1)?.value).toBe(2);expect(read.bendStyle).toBe(model.BendStyle.Default);expect(warn).toHaveBeenCalledWith(expect.stringContaining('edited'));
  });
  describe('the per-file point cap',()=>{
    const dense=(count:number)=>{
      const score=music(),notes=score.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>beat.notes[0])).slice(0,count);
      for(const note of notes)bend(note,model.BendType.Custom,model.BendStyle.Default,...Array.from({length:1024},(_,index)=>[60*index/1023,index%2?1:2]));
      score.finish(settings);return score;
    };
    it('carries a file at the cap',()=>{
      const loaded=roundTrip(dense(16));
      expect(allNotes(loaded).filter(note=>note.bendPoints?.length===1024)).toHaveLength(16);
    });
    it('stops the export of a file past the cap rather than dropping curves',()=>{
      const score=dense(16);whammy(beatsOf(score,0)[0],model.WhammyType.Custom,model.BendStyle.Default,...Array.from({length:1024},(_,index)=>[60*index/1023,index%2?-1:-2]));score.finish(settings);
      expect(()=>exportGpInterchange(score,settings)).toThrow(/more than 16384 curve points/);
    });
    it('skips curves past the cap when reading a file that holds more',()=>{
      const warn=warnings(),bytes=editDoc(exportGpInterchange(dense(16),settings),doc=>{const [first]=sidecar(doc,'Bend');first.parentNode!.append(first.cloneNode(true),first.cloneNode(true));});
      const loaded=loadInterchangeScore(bytes,settings);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('16384 curve points'));
      expect(allNotes(loaded).filter(note=>note.bendPoints?.length===1024)).toHaveLength(16);
    });
  });
});
