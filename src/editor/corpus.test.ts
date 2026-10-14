import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { model } from '@coderline/alphatab';
import { buildScore, previewEdit, trackIdentity } from '../engine';
import { blankProject } from '../project';

const manifest=resolve('.analysis/user-files/manifest.json');
it.skipIf(!existsSync(manifest))('authorized imported corpus retains music identity source hashes and percussion',()=>{
  const files=JSON.parse(readFileSync(manifest,'utf8')) as {file:string;sha256:string}[];expect(files.length).toBeGreaterThan(0);
  for(const file of files) {
    const path=resolve('.analysis/user-files',file.file),bytes=readFileSync(path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    const project={...blankProject(),base:{kind:'file' as const,filename:'private-fixture.gp',bytesBase64:bytes.toString('base64'),sha256:file.sha256}},original=buildScore(project);
    const track=original.tracks.find(t=>t.staves.some(s=>s.tuning.length&&!s.isPercussion));if(!track)continue;
    const staff=track.staves.find(s=>s.tuning.length&&!s.isPercussion)!;
    const note=staff.bars.flatMap(b=>b.voices.flatMap(v=>v.beats.flatMap(beat=>beat.notes))).find(n=>n.string>0);if(!note)continue;
    const target={track:track.index,staff:staff.index,bar:note.beat.voice.bar.index,voice:note.beat.voice.index,beat:note.beat.index};
    const technique=previewEdit(project,{type:'setNoteTechniques',target,string:note.string,patch:{palmMute:!note.isPalmMute}});
    const changed=previewEdit(technique.project,{type:'setTrackInfo',track:track.index,name:'Imported study',shortName:'Study',program:27});
    const selected=changed.score.tracks[target.track].staves[target.staff].bars[target.bar].voices[target.voice].beats[target.beat].notes.find(n=>n.string===note.string)!;
    expect(selected.realValue).toBe(note.realValue);expect(selected.isPalmMute).toBe(!note.isPalmMute);expect(trackIdentity(changed.score.tracks[track.index])).toBe(trackIdentity(track));
    for(const other of original.tracks.filter(t=>t.index!==track.index)) {
      const summary=(track:model.Track)=>track.staves.map(s=>({percussion:s.isPercussion,tuning:s.tuning,bars:s.bars.map(b=>b.voices.map(v=>v.beats.map(beat=>({duration:beat.duration,dots:beat.dots,notes:beat.notes.map(n=>[n.string,n.fret,n.percussionArticulation,n.realValue])}))))}));
      expect(summary(changed.score.tracks[other.index])).toEqual(summary(other));
    }
    expect(changed.project.base).toEqual(project.base);expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(file.sha256);
  }
},30_000);
