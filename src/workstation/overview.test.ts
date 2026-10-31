import {expect,it} from 'vitest';
import {model} from '@coderline/alphatab';
import {buildScore,previewEdit} from '../engine';
import {blankProject} from '../project';
import {overviewWindow,projectScoreOverview} from './overview';

it('projects written empty, rest and pitched measures without changing the score or project',()=>{
  const project=blankProject(),score=buildScore(project);
  const voice=score.tracks[0].staves[0].bars[0].voices[0];
  voice.beats.length=0;
  const carrier=new model.Beat();carrier.isEmpty=true;voice.addBeat(carrier);
  const note=new model.Note();note.string=6;note.fret=3;
  score.tracks[0].staves[0].bars[2].voices[0].beats[0].addNote(note);
  const before=model.JsonConverter.scoreToJsObject(score),projectBefore=structuredClone(project);
  expect(projectScoreOverview(score)).toEqual({barCount:4,sections:[],tracks:[{index:0,name:'Guitar',cells:['empty','rest','music','rest']}]});
  expect(model.JsonConverter.scoreToJsObject(score)).toEqual(before);expect(project).toEqual(projectBefore);
});

it('reads all staves and voices, percussion and real named sections',()=>{
  const edited=previewEdit(blankProject(),{type:'setNote',target:{track:0,staff:0,bar:0,voice:0,beat:0},string:6,fret:3});
  const score=edited.score,percussion=new model.Track();percussion.name='Drums';score.addTrack(percussion);
  const settingsBefore=structuredClone(edited.settings);
  const drums=new model.Staff();drums.isPercussion=true;percussion.addStaff(drums);
  const secondStaff=new model.Staff();score.tracks[0].addStaff(secondStaff);
  for(let barIndex=0;barIndex<4;barIndex++) {
    const drumBar=new model.Bar(),drumVoice=new model.Voice();drumBar.addVoice(drumVoice);drums.addBar(drumBar);
    const drumBeat=new model.Beat();drumBeat.isEmpty=false;drumVoice.addBeat(drumBeat);
    if(barIndex===1){const hit=new model.Note();hit.percussionArticulation=38;drumBeat.addNote(hit);}
    const bar=new model.Bar(),voice=new model.Voice();bar.addVoice(voice);secondStaff.addBar(bar);
    const empty=new model.Beat();empty.isEmpty=true;voice.addBeat(empty);
    const secondVoice=new model.Voice();bar.addVoice(secondVoice);
    if(barIndex===3){const beat=new model.Beat();beat.isEmpty=false;secondVoice.addBeat(beat);const note=new model.Note();note.octave=4;note.tone=0;beat.addNote(note);}
  }
  const section=new model.Section();section.text='Chorus';section.marker='B';score.masterBars[2].section=section;
  const result=projectScoreOverview(score);
  expect(result.sections).toEqual([{bar:2,text:'Chorus'}]);
  expect(result.tracks).toEqual([{index:0,name:'Guitar',cells:['music','rest','rest','music']},{index:1,name:'Drums',cells:['rest','music','rest','rest']}]);
  expect(result.tracks.every(track=>track.cells.length===result.barCount)).toBe(true);
  expect(edited.settings).toEqual(settingsBefore);
});

it.each([
  [0,280,2000,28,2,{first:0,last:12}],
  [280,280,2000,28,2,{first:8,last:22}],
  [55720,280,2000,28,2,{first:1988,last:2000}],
  [100,280,0,28,2,{first:0,last:0}],
  [0,56,1,28,2,{first:0,last:1}],
  [29,28,100,28,2,{first:0,last:5}],
])('bounds visible cells at offset %s',(offset,extent,count,cellSize,overscan,expected)=>{
  expect(overviewWindow(offset,extent,count,cellSize,overscan)).toEqual(expected);
});
