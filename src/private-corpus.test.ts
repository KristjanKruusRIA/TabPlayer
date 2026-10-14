import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildScore, previewEdit, exportGp } from './engine';
import { blankProject, type Project } from './project';
const manifest=new URL('../.analysis/user-files/manifest.json',import.meta.url);
interface Entry {file:string;source:string;sha256:string;trackCount:number;meters:string[];tunings:number[][]}
const entries:Entry[]=existsSync(manifest)?JSON.parse(readFileSync(manifest,'utf8').replace(/^\uFEFF/,'')):[];

it.skipIf(!entries.length)('checks private score import/edit/reopen/export against independent GPIF fields',()=>{
  for(const entry of entries) {
    const bytes=readFileSync(new URL(`../.analysis/user-files/${entry.file}`,import.meta.url));
    const project:Project={...blankProject(),base:{kind:'file',filename:entry.file,bytesBase64:bytes.toString('base64'),sha256:entry.sha256}};
    const score=buildScore(project);
    expect(score.tracks.length,entry.file).toBe(entry.trackCount);
    expect(score.masterBars.map(b=>`${b.timeSignatureNumerator}/${b.timeSignatureDenominator}`),entry.file).toEqual(entry.meters);
    expect(score.tracks.map(t=>t.staves[0].tuning),entry.file).toEqual(entry.tunings);
    const track=score.tracks.find(t=>!t.isPercussion && t.staves[0].tuning.length);
    expect(track).toBeDefined();
    const staff=track!.staves[0];const bar=staff.bars.find(b=>b.voices.some(v=>v.beats.some(b=>b.notes.length)));
    const voice=bar!.voices.find(v=>v.beats.some(b=>b.notes.length))!;const beat=voice.beats.find(b=>b.notes.length)!;const note=beat.notes[0];
    const target={track:track!.index,staff:0,bar:bar!.index,voice:voice.index,beat:beat.index};
    const edited=previewEdit(project,{type:'setNote',target,string:note.string,fret:note.fret+1});
    const reopened=buildScore(JSON.parse(JSON.stringify(edited.project)));
    expect(reopened.tracks[target.track].staves[0].bars[target.bar].voices[target.voice].beats[target.beat].notes.find(n=>n.string===note.string)?.fret).toBe(note.fret+1);
    expect(edited.project.base).toEqual(project.base);
    const exported=exportGp(reopened);
    const exportScore=buildScore({...blankProject(),base:{kind:'file',filename:'export.gp',bytesBase64:Buffer.from(exported).toString('base64'),sha256:createHash('sha256').update(exported).digest('hex')}});
    expect(exportScore.tracks.length).toBe(entry.trackCount);
    expect(exportScore.masterBars.map(b=>`${b.timeSignatureNumerator}/${b.timeSignatureDenominator}`)).toEqual(entry.meters);
    expect(exportScore.tracks[target.track].staves[0].bars[target.bar].voices[target.voice].beats[target.beat].notes.find(n=>n.string===note.string)?.fret).toBe(note.fret+1);
    expect(createHash('sha256').update(readFileSync(entry.source)).digest('hex')).toBe(entry.sha256);
  }
},30000);
