import { expect,it } from 'vitest';
import { buildScore,previewEdit,exportGp } from '../engine';
import { blankProject } from '../project';
import { importer,model,Settings } from '@coderline/alphatab';
import { music,noteAt } from '../editor/fixtures';
import { selectScore,selectStaves } from './selection';
import { mkdirSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { trackMixAutomations } from '../interchange/automation';
import { loadInterchangeScore } from '../interchange/gp';
import { exportMidi } from './midi';
import { applyLyricsEdit,getTrackLyrics } from '../editor/lyrics';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { setLyricsSource } from '../editor/lyrics-source';

// Decode literal SMF note-ons independently of alphaTab's event model.
function midiNotes(bytes:Uint8Array) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),notes:{tick:number;key:number}[]=[];let p=14;
  const variable=()=>{let value=0,byte;do{byte=bytes[p++];value=(value<<7)|(byte&127);}while(byte&128);return value;};
  for(let track=0;track<view.getUint16(10);track++) {
    p+=4;const end=p+4+view.getUint32(p);p+=4;let tick=0,status=0;
    while(p<end) {
      tick+=variable();let byte=bytes[p++];if(byte<128){p--;byte=status;}else if(byte<240)status=byte;
      if(byte===255){p++;const length=variable();p+=length;}
      else if(byte===240||byte===247){const length=variable();p+=length;}
      else {const type=byte&240;if(type===144&&bytes[p+1]>0)notes.push({tick,key:bytes[p]});p+=type===192||type===208?1:2;}
    }
  }
  return notes;
}
function simileScore(kind:'single'|'double') {
  const score=music(),bars=score.tracks[0].staves[0].bars;
  for(const bar of bars)for(const beat of bar.voices[0].beats){beat.notes[0].string=1;beat.notes[0].fret=bar.index*4+beat.index;}
  if(kind==='single')bars[1].simileMark=model.SimileMark.Simple;
  else {bars[2].simileMark=model.SimileMark.FirstOfDouble;bars[3].simileMark=model.SimileMark.SecondOfDouble;}
  score.finish(new Settings());return score;
}
it('materializes single similes whose sounding predecessor is outside a GP excerpt',()=>{
  const score=simileScore('single'),before=model.JsonConverter.scoreToJson(score),selection={tracks:[0],range:{first:1,last:1}};
  const selected=selectScore(score,selection),reopened=loadInterchangeScore(exportGp(selected),new Settings());
  expect(selected.tracks[0].staves[0].bars[0].simileMark).toBe(model.SimileMark.None);
  expect(midiNotes(exportMidi(reopened,{tracks:[0],range:null}))).toEqual([{tick:0,key:40},{tick:960,key:41},{tick:1920,key:42},{tick:2880,key:43}]);
  expect(midiNotes(exportMidi(score,selection))).toEqual(midiNotes(exportMidi(reopened,{tracks:[0],range:null})));
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('materializes cut double simile halves and retains fully contained source and pair context',()=>{
  const score=simileScore('double'),before=model.JsonConverter.scoreToJson(score);
  for(const [first,last,keys]of [[2,2,[40,41,42,43]],[3,3,[44,45,46,47]],[2,3,[40,41,42,43,44,45,46,47]],[1,3,[44,45,46,47,40,41,42,43,44,45,46,47]]] as const) {
    const selection={tracks:[0],range:{first,last}},selected=selectScore(score,selection),reopened=loadInterchangeScore(exportGp(selected),new Settings());
    expect(selected.tracks[0].staves[0].bars.every(bar=>bar.simileMark===model.SimileMark.None)).toBe(true);
    expect(midiNotes(exportMidi(reopened,{tracks:[0],range:null})).map(note=>note.key)).toEqual(keys);
    expect(midiNotes(exportMidi(score,selection))).toEqual(midiNotes(exportMidi(reopened,{tracks:[0],range:null})));
    const ids=selected.tracks[0].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats.flatMap(beat=>beat.notes.map(note=>note.id))));
    expect(new Set(ids).size).toBe(ids.length);
  }
  expect(selectScore(score,{tracks:[0],range:{first:0,last:3}}).tracks[0].staves[0].bars.map(bar=>bar.simileMark)).toEqual([0,0,2,3]);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('keeps materialized source links and destination mix while retaining archive siblings and backing',()=>{
  const authored=simileScore('double'),audio=new Uint8Array([82,73,70,70,1,2,3,4]);
  authored.backingTrack=new model.BackingTrack();authored.backingTrack.rawAudioFile=audio;
  const entries=unzipSync(exportGp(authored));entries['Content/Assets/selection.txt']=strToU8('selection sibling');
  const score=loadInterchangeScore(zipSync(entries),new Settings()),origin=noteAt(score),destination=noteAt(score,0,1);
  origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;
  origin.beat.invertBeamDirection=true;origin.dynamics=model.DynamicValue.P;destination.dynamics=model.DynamicValue.FF;
  origin.beat.automations.push(automation(model.AutomationType.Volume,4,.75));
  noteAt(score,2).beat.automations.push(automation(model.AutomationType.Volume,8,.5));
  const before=model.JsonConverter.scoreToJson(score),selected=selectScore(score,{tracks:[0],range:{first:0,last:2}}),copied=noteAt(selected,2),next=noteAt(selected,2,1);
  expect(copied.slurDestination).toBe(next);expect(next.slurOrigin).toBe(copied);expect(copied.id).not.toBe(origin.id);
  expect(copied.beat.invertBeamDirection).toBe(true);expect([copied.dynamics,next.dynamics]).toEqual([2,6]);
  expect(trackMixAutomations(selected.tracks[0]).map(({bar,automation:a})=>[bar,a.ratioPosition,a.value])).toEqual([[0,.75,4],[2,.5,8]]);
  const exported=exportGp(selected),reopened=loadInterchangeScore(exported,new Settings());
  expect(unzipSync(exported)['Content/Assets/selection.txt']).toEqual(strToU8('selection sibling'));
  expect(reopened.backingTrack?.rawAudioFile).toEqual(audio);expect(selected.backingTrack?.rawAudioFile).not.toBe(score.backingTrack?.rawAudioFile);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);expect(audio).toEqual(new Uint8Array([82,73,70,70,1,2,3,4]));
});
it('retains authoritative edge fermatas and stem inversion without importing outside holds',()=>{
  const score=music(),bars=score.tracks[0].staves[0].bars;
  for(const [index,type,length]of [[0,0,1],[1,1,1.5],[2,2,2],[3,0,3]])score.masterBars[index].fermata=new Map([[index===2?2880:0,Object.assign(new model.Fermata(),{type,length})]]);
  bars[1].voices[0].beats[0].invertBeamDirection=true;bars[2].voices[0].beats[3].invertBeamDirection=true;
  const before=model.JsonConverter.scoreToJson(score),selected=selectScore(score,{tracks:[0],range:{first:1,last:2}});
  expect(selected.masterBars.map(bar=>[...bar.fermata!.entries()].map(([offset,value])=>[offset,value.type,value.length]))).toEqual([[[0,1,1.5]],[[2880,2,2]]]);
  expect(noteAt(selected).beat.invertBeamDirection).toBe(true);expect(noteAt(selected,1,3).beat.invertBeamDirection).toBe(true);
  expect(noteAt(selected).beat.fermata).toBe(selected.masterBars[0].fermata!.get(0));
  expect(noteAt(selected,1,3).beat.fermata).toBe(selected.masterBars[1].fermata!.get(2880));
  const reopened=loadInterchangeScore(exportGp(selected),new Settings());
  expect(reopened.masterBars.map(bar=>[...bar.fermata!.entries()].map(([offset,value])=>[offset,value.type,value.length]))).toEqual([[[0,1,1.5]],[[2880,2,2]]]);
  expect(noteAt(reopened).beat.invertBeamDirection).toBe(true);expect(noteAt(reopened,1,3).beat.invertBeamDirection).toBe(true);
  expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('keeps raw lyrics attached to their track when selected tracks are reordered',()=>{
  const score=music();score.addTrack(music().tracks[0]);score.finish(new Settings());
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'[FIRST] first lyrics'}]});
  applyLyricsEdit(score,{type:'setTrackLyrics',track:1,visible:false,lines:[{startBar:1,text:'[SECOND] private verse'}]});
  const selected=selectScore(score,{tracks:[1,0],range:null});
  expect(getTrackLyrics(selected,0)).toEqual({source:'raw',visible:false,lines:[{startBar:1,text:'[SECOND] private verse'}]});
  expect(getTrackLyrics(selected,1)).toEqual({source:'raw',visible:true,lines:[{startBar:0,text:'[FIRST] first lyrics'}]});
});
it('reconstructs only selected lyric syllables with relative offsets and eligible-beat gaps',()=>{
  const score=music(),lines=[{startBar:0,text:'[VERSE] one two three four five six  eight nine ten eleven twelve thirteen'},{startBar:2,text:'  lead+voice end'}];
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines});
  const before=model.JsonConverter.scoreToJson(score),selected=selectScore(score,{tracks:[0],range:{first:1,last:2}});
  expect(getTrackLyrics(selected,0)).toEqual({source:'raw',visible:true,lines:[{startBar:0,text:'five six  eight nine ten eleven twelve'},{startBar:1,text:'  lead+voice end'}]});
  expect(selected.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>beat.lyrics))).toEqual([['five',''],['six',''],['',''],['eight',''],['nine',''],['ten',''],['eleven','lead voice'],['twelve','end']]);
  const bytes=exportGp(selected),xml=new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(bytes)['Content/score.gpif']),'application/xml');
  expect([...xml.querySelectorAll('GPIF > Tracks > Track > Lyrics > Line')].map(line=>[line.querySelector('Offset')?.textContent,line.querySelector('Text')?.textContent])).toEqual([['0','five six  eight nine ten eleven twelve'],['1','  lead+voice end']]);
  const reopened=loadInterchangeScore(bytes,new Settings());expect(getTrackLyrics(reopened,0)).toEqual(getTrackLyrics(selected,0));
  expect(reopened.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.map(beat=>beat.lyrics))).toEqual([['five',''],['six',''],['',''],['eight',''],['nine',''],['ten',''],['eleven','lead voice'],['twelve','end']]);
  expect(getTrackLyrics(score,0)).toEqual({source:'raw',visible:true,lines});expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('retains selected hidden lyric source without exposing hidden syllables',()=>{
  const score=music(),lines=[{startBar:0,text:'one two three four five six  eight nine ten eleven twelve thirteen'},{startBar:2,text:'  lead+voice end'}];
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:false,lines});
  const before=model.JsonConverter.scoreToJson(score),selected=selectScore(score,{tracks:[0],range:{first:1,last:2}});
  expect(getTrackLyrics(selected,0)).toEqual({source:'raw',visible:false,lines:[{startBar:0,text:'five six  eight nine ten eleven twelve'},{startBar:1,text:'  lead+voice end'}]});
  expect(selected.tracks[0].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats)).every(beat=>!beat.lyrics)).toBe(true);
  const bytes=exportGp(selected),xml=new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(bytes)['Content/score.gpif']),'application/xml');
  expect(xml.querySelector('GPIF > Tracks > Track > Lyrics')?.getAttribute('dispatched')).toBe('false');
  expect([...xml.querySelectorAll('GPIF > Tracks > Track > Lyrics > Line')].map(line=>[line.querySelector('Offset')?.textContent,line.querySelector('Text')?.textContent])).toEqual([['0','five six  eight nine ten eleven twelve'],['1','  lead+voice end']]);
  const reopened=loadInterchangeScore(bytes,new Settings());expect(getTrackLyrics(reopened,0)).toEqual(getTrackLyrics(selected,0));
  expect(reopened.tracks[0].staves[0].bars.flatMap(bar=>bar.voices.flatMap(voice=>voice.beats)).every(beat=>!beat.lyrics)).toBe(true);
  expect(getTrackLyrics(score,0)).toEqual({source:'raw',visible:false,lines});expect(model.JsonConverter.scoreToJson(score)).toBe(before);
});
it('keeps blank distributed verse slots valid in nonzero GP ranges',()=>{
  const score=music();noteAt(score,2,2).beat.lyrics=['','late voice'];
  const selected=selectScore(score,{tracks:[0],range:{first:1,last:2}});
  expect(getTrackLyrics(selected,0)).toEqual({source:'raw',visible:true,lines:[{startBar:0,text:''},{startBar:1,text:'  late+voice'}]});
});
it('excludes imported hidden verses starting beyond the source score without invalid range offsets',()=>{
  const score=music();setLyricsSource(score.tracks[0],{visible:false,lines:[{startBar:99,text:'future verse'}]},false);
  const selected=selectScore(score,{tracks:[0],range:{first:1,last:2}});
  expect(getTrackLyrics(selected,0)).toEqual({source:'raw',visible:false,lines:[{startBar:1,text:''}]});
  expect(getTrackLyrics(score,0).lines).toEqual([{startBar:99,text:'future verse'}]);
});
it('does not transfer omitted first-staff raw lyrics onto a lower-staff-only excerpt',()=>{
  const score=music();score.tracks[0].addStaff(music().tracks[0].staves[0]);score.finish(new Settings());
  applyLyricsEdit(score,{type:'setTrackLyrics',track:0,visible:true,lines:[{startBar:0,text:'first staff lyrics'}]});
  for(const selected of [selectStaves(score,{tracks:[0],staves:{0:[1]},range:null}),selectScore(score,{tracks:[0],staves:{0:[1]},range:{first:1,last:2}})]) {
    expect(getTrackLyrics(selected,0).lines).toEqual([]);
    expect(selected.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats).every(beat=>!beat.lyrics)).toBe(true);
  }
  expect(getTrackLyrics(score,0).lines).toEqual([{startBar:0,text:'first staff lyrics'}]);
});
function phraseScore(){
  const score=music(),origin=noteAt(score),destination=noteAt(score,2);
  destination.string=5;destination.fret=7;noteAt(score,1,3).string=5;noteAt(score,1,3).fret=4;score.finish(new Settings());
  origin.slurDestination=destination;destination.slurOrigin=origin;destination.isSlurDestination=true;return score;
}
const automation=(type:model.AutomationType,value:number,ratioPosition=0)=>Object.assign(new model.Automation(),{type,value,ratioPosition});
it('inherits mix state by bar position when controller carriers occur in a different beat order',()=>{
  const score=music(),beats=score.tracks[0].staves[0].bars[0].voices[0].beats;
  beats[0].automations.push(automation(model.AutomationType.Volume,4,.75));
  beats[2].automations.push(automation(model.AutomationType.Volume,8,.5));
  const selected=selectScore(score,{tracks:[0],range:{first:1,last:3}});
  expect(selected.tracks[0].playbackInfo.volume).toBe(4);
});
it('retains track-wide controllers when the exported staff differs from the imported carrier',()=>{
  const score=previewEdit(blankProject(),{type:'addStaff',track:0,settings:{tuning:[],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:false,showNotation:true}}).score;
  score.tracks[0].staves[0].bars[0].voices[0].beats[0].automations.push(automation(model.AutomationType.Volume,4,.75));
  const imported=loadInterchangeScore(exportGp(score),new Settings()),before=model.JsonConverter.scoreToJson(imported);
  for(const selected of [selectStaves(imported,{tracks:[0],staves:{0:[1]},range:null}),selectScore(imported,{tracks:[0],staves:{0:[1]},range:null})]) {
    expect(trackMixAutomations(selected.tracks[0]).map(({bar,automation:a})=>[bar,a.ratioPosition,a.value])).toEqual([[0,.75,4]]);
    const gp=loadInterchangeScore(exportGp(selected),new Settings());
    expect(trackMixAutomations(gp.tracks[0]).map(({bar,automation:a})=>[bar,a.ratioPosition,a.value])).toEqual([[0,.75,4]]);
  }
  expect(model.JsonConverter.scoreToJson(imported)).toBe(before);
});
it('selected GP snapshot keeps the chosen music and repairs relationships cut by range',()=>{
  let p=previewEdit(blankProject(),{type:'addTrack',name:'Bass',tuning:[43,38,33,28],program:33}).project;
  p=previewEdit(p,{type:'setNote',target:{track:1,staff:0,bar:1,voice:0,beat:0},string:1,fret:5}).project;
  p=previewEdit(p,{type:'setNote',target:{track:1,staff:0,bar:0,voice:0,beat:3},string:1,fret:5}).project;
  const original=buildScore(p);original.title='Selected';const note=original.tracks[1].staves[0].bars[1].voices[0].beats[0].notes[0];note.isTieDestination=true;
  const selected=selectScore(original,{tracks:[1],range:{first:1,last:2}});
  expect(selected.tracks).toHaveLength(1);expect(selected.masterBars).toHaveLength(2);expect(selected.tracks[0].name).toBe('Bass');
  expect(selected.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].fret).toBe(5);
  expect(original.tracks).toHaveLength(2);expect(original.masterBars).toHaveLength(4);
  const round=importer.ScoreLoader.loadScoreFromBytes(exportGp(selected),new Settings());expect(round.tracks).toHaveLength(1);expect(round.masterBars).toHaveLength(2);
});
it('exports only explicitly selected staves and rejects an empty staff set',()=>{
  let p=previewEdit(blankProject(),{type:'addStaff',track:0,settings:{tuning:[43,38,33,28],capo:0,transposition:0,displayTransposition:0,clef:4,showTab:true,showNotation:true}}).project;
  p=previewEdit(p,{type:'setNote',target:{track:0,staff:1,bar:0,voice:0,beat:0},string:1,fret:5}).project;
  const original=buildScore(p);const selected=selectScore(original,{tracks:[0],range:null,staves:{0:[1]}});
  expect(selected.tracks[0].staves).toHaveLength(1);expect(selected.tracks[0].staves[0].tuning).toEqual([43,38,33,28]);expect(original.tracks[0].staves).toHaveLength(2);
  expect(()=>selectScore(original,{tracks:[0],range:null,staves:{0:[]}})).toThrow(/staff|staves/i);
});
it('retains an explicit nonadjacent cross-string phrase origin in selected copies',()=>{
  const score=phraseScore();
  for(const selected of [selectStaves(score,{tracks:[0],range:null,staves:{0:[0]}}),selectScore(score,{tracks:[0],range:{first:0,last:2}})]){
    expect(noteAt(selected,2).slurOrigin).toBe(noteAt(selected));expect(noteAt(selected).slurDestination).toBe(noteAt(selected,2));
    expect(noteAt(selected,2).slurOrigin).not.toBe(noteAt(selected,1,3));expect(noteAt(selected)).not.toBe(noteAt(score));
  }
  expect(noteAt(score).slurDestination).toBe(noteAt(score,2));expect(noteAt(score,2).slurOrigin).toBe(noteAt(score));
});
it('records public GP phrase-slur coverage independently of the selected model relationship',()=>{
  const original=phraseScore(),selected=selectScore(original,{tracks:[0],range:null});const results=[];
  for(const [kind,score]of [['direct',original],['selected',selected]] as const){
    const bytes=exportGp(score),reopened=importer.ScoreLoader.loadScoreFromBytes(bytes,new Settings()),origin=noteAt(score),destination=noteAt(score,2);
    expect(destination.slurOrigin?.id).toBe(origin.id);expect(noteAt(reopened,2).string).toBe(5);expect(noteAt(reopened,2).fret).toBe(7);
    const after=noteAt(reopened,2).slurOrigin;results.push({kind,retained:after===noteAt(reopened),before:{originBar:origin.beat.voice.bar.index,originBeat:origin.beat.index,originString:origin.string,destinationBar:destination.beat.voice.bar.index,destinationString:destination.string},after:after?{originBar:after.beat.voice.bar.index,originBeat:after.beat.index,originString:after.string}:null,exportSha256:createHash('sha256').update(bytes).digest('hex')});
    mkdirSync('.analysis/expansion',{recursive:true});writeFileSync(`.analysis/expansion/phrase-slur-${kind}.gp`,bytes);
  }
  writeFileSync('.analysis/expansion/gp-export-phrase-slur-coverage.json',JSON.stringify({engineVersion:'1.8.4',results},null,2));
  expect(noteAt(original).slurDestination).toBe(noteAt(original,2));expect(noteAt(selected).slurDestination).toBe(noteAt(selected,2));
});
it('detaches a phrase slur when either explicit endpoint falls outside the selected range',()=>{
  const score=phraseScore(),left=selectScore(score,{tracks:[0],range:{first:0,last:1}}),right=selectScore(score,{tracks:[0],range:{first:1,last:3}});
  expect(noteAt(left).slurDestination).toBeNull();expect(noteAt(right,1).slurOrigin).toBeNull();expect(noteAt(right,1).isSlurDestination).toBe(false);
  const reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(right),new Settings());expect(noteAt(reopened,1).isSlurDestination).toBe(false);
  expect(noteAt(score).slurDestination).toBe(noteAt(score,2));expect(noteAt(score,2).slurOrigin).toBe(noteAt(score));
});
it('seeds ranged GP tempo program bank volume and pan while preserving selected midbar updates',()=>{
  const score=music(),track=score.tracks[0];score.masterBars[0].tempoAutomations=[automation(model.AutomationType.Tempo,120)];score.masterBars[1].tempoAutomations=[automation(model.AutomationType.Tempo,60)];
  noteAt(score,1).beat.automations.push(automation(model.AutomationType.Instrument,33),automation(model.AutomationType.Bank,257),automation(model.AutomationType.Volume,4),automation(model.AutomationType.Balance,2));
  score.masterBars[2].tempoAutomations=[automation(model.AutomationType.Tempo,80,.5)];noteAt(score,2,2).beat.automations.push(automation(model.AutomationType.Instrument,40,.5),automation(model.AutomationType.Volume,8,.5),automation(model.AutomationType.Balance,14,.5));
  score.masterBars[3].tempoAutomations=[automation(model.AutomationType.Tempo,90)];noteAt(score,3).beat.automations.push(automation(model.AutomationType.Instrument,41));
  const before=JSON.stringify(model.JsonConverter.scoreToJson(score)),selected=selectScore(score,{tracks:[0],range:{first:2,last:3}});
  const reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(selected),new Settings());expect(reopened.tempo).toBe(60);expect(reopened.tracks[0].playbackInfo).toMatchObject({program:33,bank:257,volume:4,balance:2});
  expect(reopened.masterBars[0].tempoAutomations.map(a=>[a.ratioPosition,a.value])).toEqual([[0,60],[.5,80]]);expect(reopened.masterBars[1].tempoAutomations.map(a=>[a.ratioPosition,a.value])).toEqual([[0,90]]);
  expect(reopened.tracks[0].staves[0].bars[0].voices[0].beats.flatMap(beat=>beat.automations.filter(a=>a.type===model.AutomationType.Instrument).map(a=>[a.value,a.ratioPosition]))).toEqual([[33,0],[40,.5]]);expect(noteAt(reopened,1).beat.getAutomation(model.AutomationType.Instrument)?.value).toBe(41);
  expect(noteAt(selected,0,2).beat.automations.filter(a=>a.type===model.AutomationType.Volume||a.type===model.AutomationType.Balance).map(a=>[a.type,a.value,a.ratioPosition])).toEqual([[model.AutomationType.Volume,8,.5],[model.AutomationType.Balance,14,.5]]);
  expect(noteAt(selected,0,2).beat.getAutomation(model.AutomationType.Instrument)?.value).toBe(40);
  expect(track.playbackInfo.program).toBe(25);expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(before);
});
it('honors explicit playback changes at the first selected instant instead of overriding them with prior state',()=>{
  const score=music();score.masterBars[1].tempoAutomations=[automation(model.AutomationType.Tempo,60)];noteAt(score,1).beat.automations.push(automation(model.AutomationType.Instrument,33));
  score.masterBars[2].tempoAutomations=[automation(model.AutomationType.Tempo,100)];noteAt(score,2).beat.automations.push(automation(model.AutomationType.Instrument,42),automation(model.AutomationType.Volume,6),automation(model.AutomationType.Balance,12));
  const selected=selectScore(score,{tracks:[0],range:{first:2,last:3}}),reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(selected),new Settings());
  expect(selected.tracks[0].playbackInfo).toMatchObject({program:42,volume:6,balance:12});expect(reopened.tracks[0].playbackInfo).toMatchObject({program:42,volume:6,balance:12});
  expect(reopened.tempo).toBe(100);expect(reopened.masterBars[0].tempoAutomations.filter(a=>a.ratioPosition===0)).toHaveLength(1);
});
it('keeps fully contained repeats and removes repeat or ending markers whose written-bar context is cut',()=>{
  const score=music();score.masterBars[0].isRepeatStart=true;score.masterBars[2].repeatCount=2;score.masterBars[2].alternateEndings=1;
  const right=selectScore(score,{tracks:[0],range:{first:1,last:3}}),left=selectScore(score,{tracks:[0],range:{first:0,last:1}});
  expect(right.masterBars.every(bar=>!bar.isRepeatStart&&bar.repeatCount===0&&bar.alternateEndings===0)).toBe(true);expect(left.masterBars[0].isRepeatStart).toBe(false);
  const full=selectScore(score,{tracks:[0],range:{first:0,last:2}}),reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(full),new Settings());
  expect(reopened.masterBars[0].isRepeatStart).toBe(true);expect(reopened.masterBars[2].repeatCount).toBe(2);expect(reopened.masterBars[2].alternateEndings).toBe(1);
  expect(score.masterBars[0].isRepeatStart).toBe(true);expect(score.masterBars[2].repeatCount).toBe(2);
});
it('seeds an active sustain pedal at the selected boundary and retains its in-range release',()=>{
  const score=music(),staff=score.tracks[0].staves[0],down=new model.SustainPedalMarker(),up=new model.SustainPedalMarker();down.pedalType=model.SustainPedalMarkerType.Down;down.ratioPosition=.5;up.pedalType=model.SustainPedalMarkerType.Up;up.ratioPosition=.5;
  staff.bars[1].sustainPedals.push(down);staff.bars[3].sustainPedals.push(up);score.finish(new Settings());const before=JSON.stringify(model.JsonConverter.scoreToJson(score));
  const selected=selectScore(score,{tracks:[0],range:{first:2,last:3}}),reopened=importer.ScoreLoader.loadScoreFromBytes(exportGp(selected),new Settings());
  expect(reopened.tracks[0].staves[0].bars[0].sustainPedals.map(marker=>[marker.ratioPosition,marker.pedalType])).toEqual([[0,model.SustainPedalMarkerType.Down]]);
  expect(reopened.tracks[0].staves[0].bars[1].sustainPedals.map(marker=>[marker.ratioPosition,marker.pedalType])).toEqual([[.5,model.SustainPedalMarkerType.Up]]);expect(JSON.stringify(model.JsonConverter.scoreToJson(score))).toBe(before);
});
