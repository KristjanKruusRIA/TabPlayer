import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exporter,importer,model,Settings } from '@coderline/alphatab';
import { unzipSync,zipSync } from 'fflate';

/** The fret of every note of the dense score, so a driver can say what a click on a drawn number must have selected. */
export const denseBars=32,denseBarsPerSystem=8;
export const denseFret=(bar,beat)=>1+(bar*5+beat*3)%21;

/**
 * Builds a GP7 file the test owns (nothing private): 32 bars of eighth notes (or sixteenths with perBar 16, which no layout can fit), a guitar with two-digit frets, with the systems
 * forced to eight bars each. That is the crowded case the layouts are meant to cope with. Returns the file bytes.
 */
export function buildDenseScore({title='Dense forced systems',barsPerSystem=denseBarsPerSystem,perBar=8}={}) {
  const duration=perBar===16?model.Duration.Sixteenth:perBar===4?model.Duration.Quarter:model.Duration.Eighth;
  const score=new model.Score(),settings=new Settings();
  score.title=title;score.artist='TabPlayer display-mode study';
  if(barsPerSystem){score.defaultSystemsLayout=barsPerSystem;score.systemsLayout=[];}
  for(let bar=0;bar<denseBars;bar++){const master=new model.MasterBar();master.timeSignatureNumerator=4;master.timeSignatureDenominator=4;if(bar===0)master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,120,2)];score.addMasterBar(master);}
  const track=new model.Track(),staff=new model.Staff();
  track.name='Dense guitar';track.shortName='Gtr';if(barsPerSystem){track.defaultSystemsLayout=barsPerSystem;track.systemsLayout=[];}
  Object.assign(track.playbackInfo,{program:25,primaryChannel:0,secondaryChannel:1});
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;staff.showStandardNotation=true;track.addStaff(staff);score.addTrack(track);
  let barId=0,beatId=0,noteId=0;
  for(let b=0;b<denseBars;b++){
    const bar=new model.Bar(),voice=new model.Voice();bar.id=barId;voice.id=barId++;bar.clef=model.Clef.G2;staff.addBar(bar);bar.addVoice(voice);
    for(let q=0;q<perBar;q++){
      const beat=new model.Beat();beat.id=beatId++;beat.duration=duration;beat.isEmpty=false;voice.addBeat(beat);
      const note=new model.Note();note.id=noteId++;note.string=1+(b+q)%6;note.fret=denseFret(b,q);beat.addNote(note);
    }
  }
  score.rebuildRepeatGroups();score.finish(settings);
  const bytes=Buffer.from(zipSync(unzipSync(new exporter.Gp7Exporter().export(score,settings)),{mtime:new Date(2000,0,1)}));
  const loaded=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
  assert.equal(loaded.masterBars.length,denseBars);
  const notes=loaded.tracks[0].staves[0].bars.flatMap(bar=>bar.voices[0].beats.flatMap(beat=>beat.notes));
  assert.equal(notes.length,denseBars*perBar);assert.equal(notes[perBar+1].fret,denseFret(1,1));
  return bytes;
}

export function writeDenseScore(directory,name='dense-forced-systems.gp',options={}) {
  mkdirSync(directory,{recursive:true});const path=resolve(directory,name);writeFileSync(path,buildDenseScore(options));return path;
}
