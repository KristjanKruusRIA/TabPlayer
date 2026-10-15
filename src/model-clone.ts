import { model, type Settings } from '@coderline/alphatab';

type NoteJson={id:number;dynamics:number};
type BeatJson={notes:NoteJson[]};
type VoiceJson={beats:BeatJson[]};
type BarJson={voices:VoiceJson[]};
type StaffJson={bars:BarJson[]};
type TrackJson={staves:StaffJson[]};

/** Public Beat.finish assigns beat dynamics to every note, even on JSON replay. */
export function scoreFromJson(json:ReturnType<typeof model.JsonConverter.scoreToJson>,settings:Settings):model.Score {
  const source=JSON.parse(json) as {tracks:TrackJson[]};
  const dynamics=new Map(source.tracks.flatMap(t=>t.staves.flatMap(s=>s.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(b=>b.notes.map(n=>[n.id,n.dynamics] as const)))))));
  const score=model.JsonConverter.jsonToScore(json,settings);
  for(const track of score.tracks)for(const staff of track.staves)for(const bar of staff.bars)for(const voice of bar.voices)for(const beat of voice.beats)for(const note of beat.notes) {
    const value=dynamics.get(note.id);if(value!==undefined)note.dynamics=value;
  }
  return score;
}
