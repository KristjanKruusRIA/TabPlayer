import { expect, it } from 'vitest';
import { exporter, importer, Settings } from '@coderline/alphatab';
import type { EditCommand } from '../edit-types';
import { applySongEdit } from './song';
import { music, reopened } from './fixtures';

const fields={subTitle:'Subtitle',album:'Album',words:'Lyrics author',music:'Composer',copyright:'Copyright',tab:'Transcriber',notices:'First line\nSecond line',instructions:'Play softly\nThen crescendo'};

it('all eight metadata fields survive native model and public GP roundtrip without replacing title or artist',()=>{
  const score=music();score.title='Title';score.artist='Artist';
  expect(applySongEdit(score,{type:'setScoreMetadata',fields})).toBe(true);
  const gp=importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(score,new Settings()),new Settings());
  for(const copy of [score,reopened(score),gp]) {
    expect(Object.fromEntries(Object.keys(fields).map(key=>[key,copy[key as keyof typeof fields]]))).toEqual(fields);
    expect(copy.title).toBe('Title');expect(copy.artist).toBe('Artist');
  }
});

it('empty metadata values clear all eight fields',()=>{
  const score=music();Object.assign(score,fields);
  const empty={subTitle:'',album:'',words:'',music:'',copyright:'',tab:'',notices:'',instructions:''};
  applySongEdit(score,{type:'setScoreMetadata',fields:empty});
  expect(Object.fromEntries(Object.keys(empty).map(key=>[key,score[key as keyof typeof empty]]))).toEqual(empty);
});

it.each([null,{...fields,album:5},{subTitle:'Incomplete'},{...fields,unknown:'Extra'}])('malformed metadata rejects before assigning any field: %j',invalid=>{
  const score=music();score.subTitle='Original';
  expect(()=>applySongEdit(score,{type:'setScoreMetadata',fields:invalid} as unknown as EditCommand)).toThrow(/metadata/i);
  expect(score.subTitle).toBe('Original');expect(score.album).toBe('');
});

it('leaves commands owned by another router untouched',()=>{
  const score=music();expect(applySongEdit(score,{type:'appendMeasure'})).toBe(false);expect(score.masterBars).toHaveLength(4);
});
