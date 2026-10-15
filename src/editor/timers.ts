import { midi, model, Settings } from '@coderline/alphatab';
import { scoreFromJson } from '../model-clone';

const beats=(score:model.Score)=>score.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats))));

export function prepareScoreTimers(score:model.Score):void {
  const wanted=beats(score).filter(b=>b.showTimer);
  if(!wanted.length)return;
  const settings=new Settings(),copy=scoreFromJson(model.JsonConverter.scoreToJson(score),settings);
  const file=new midi.MidiFile(),generator=new midi.MidiFileGenerator(copy,settings,new midi.AlphaSynthMidiFileHandler(file));
  generator.generate();
  const tempos=[...new Map(file.tracks.flatMap(t=>t.events).filter((e):e is midi.TempoChangeEvent=>e instanceof midi.TempoChangeEvent).map(e=>[e.tick,e])).values()].sort((a,b)=>a.tick-b.tick);
  const performed=new Set(generator.tickLookup.masterBars.map(b=>b.masterBar.index));
  // 1.8.4's timer counter advances once per staff and overcounts later tempo
  // bars. Use the same generated tick/tempo timeline as playback instead.
  for(const beat of beats(copy))if(beat.showTimer) {
    beat.timer=null;
    if(!performed.has(beat.voice.bar.index)||!generator.tickLookup.getRelativeBeatPlaybackRange(beat))continue;
    const tick=generator.tickLookup.getBeatStart(beat)+file.tickShift;
    let elapsed=0,previous=0,tempo=copy.tempo;
    for(const change of tempos) {
      if(change.tick>tick)break;
      elapsed+=(change.tick-previous)*60000/(960*tempo);previous=change.tick;tempo=change.beatsPerMinute;
    }
    beat.timer=elapsed+(tick-previous)*60000/(960*tempo);
  }
  const timers=new Map(beats(copy).map(b=>[b.id,b.timer]));
  for(const beat of wanted)beat.timer=timers.get(beat.id)??null;
}
