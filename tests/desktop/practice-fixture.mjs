import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exporter,importer,model,Settings } from '@coderline/alphatab';

export const practiceFixture=resolve('.analysis/desktop-smoke/gp8-practice-source.gp');
export function buildPracticeFixture(){
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff(),settings=new Settings();
  score.title='Authored practice timing';track.name='A4 guitar';track.playbackInfo.program=25;track.playbackInfo.secondaryChannel=1;
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.showTablature=true;track.addStaff(staff);score.addTrack(track);
  for(let index=0;index<2;index++){
    const master=new model.MasterBar();master.tempoAutomations=[model.Automation.buildTempoAutomation(false,0,index===0?120:60,2)];score.addMasterBar(master);
    const bar=new model.Bar(),voice=new model.Voice();bar.clef=model.Clef.G2;bar.addVoice(voice);staff.addBar(bar);
    for(let index=0;index<4;index++){const beat=new model.Beat(),note=new model.Note();beat.duration=4;beat.isEmpty=false;note.string=6;note.fret=5;note.isStaccato=true;beat.addNote(note);voice.addBeat(beat);}
  }
  score.finish(settings);const bytes=new exporter.Gp7Exporter().export(score,settings),copy=importer.ScoreLoader.loadScoreFromBytes(bytes,settings);
  assert.deepEqual(copy.masterBars.map(bar=>bar.tempoAutomations[0].value),[120,60]);
  assert.ok(copy.tracks[0].staves[0].bars.every(bar=>bar.voices[0].beats.every(beat=>beat.notes[0].realValue===69)));
  mkdirSync(resolve('.analysis/desktop-smoke'),{recursive:true});writeFileSync(practiceFixture,bytes);return practiceFixture;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(buildPracticeFixture());
