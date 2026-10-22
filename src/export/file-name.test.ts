import { describe,expect,it } from 'vitest';
import { model } from '@coderline/alphatab';
import { DEFAULT_FILE_NAME,expandFileName,fileNameContext,withExtension } from './file-name';

const now=new Date(2026,2,30,13,3,59);
const context={title:'Anatole',trackName:'Lead Guitar',trackNumber:3,trackCount:5,now};

describe('expandFileName',()=>{
  it('replaces every GP8 token',()=>{
    expect(DEFAULT_FILE_NAME).toBe('%T');
    expect(expandFileName('%T',context)).toBe('Anatole');
    expect(expandFileName('%t',context)).toBe('Lead Guitar');
    expect(expandFileName('%n',context)).toBe('3');
    expect(expandFileName('%N',context)).toBe('5');
    expect(expandFileName('%d',context)).toBe('2026-03-30');
    expect(expandFileName('%h',context)).toBe('13-03');
    expect(expandFileName('%T - %t (%n of %N) %d %h',context)).toBe('Anatole - Lead Guitar (3 of 5) 2026-03-30 13-03');
  });
  it('keeps literal percent signs and unknown tokens',()=>{
    expect(expandFileName('100%% %x %',context)).toBe('100% %x %');
    expect(expandFileName('%%T',context)).toBe('%T');
  });
  it('makes the name safe to save on every desktop system',()=>{
    expect(expandFileName('%T',{...context,title:'AC/DC: Back\\In <Black>? *|"'})).toBe('AC-DC- Back-In -Black-- ---');
    expect(expandFileName(' . %T . ',context)).toBe('Anatole');
    expect(expandFileName('%T',{...context,title:'a\u0007b'})).toBe('a-b');
    expect(expandFileName('%T',{...context,title:'con'})).toBe('_con');
    expect(expandFileName('%T',{...context,title:'LPT1'})).toBe('_LPT1');
    expect(expandFileName('%T',{...context,title:'COM¹.mid'})).toBe('_COM¹.mid');
    expect(expandFileName('%T',{...context,title:'CON.a\u2028b'})).toBe('_CON.a-b');
    expect(expandFileName('%T',{...context,title:'a\u0085b'})).toBe('a-b');
    // Invisible direction marks would let "Report\u202efdp.wav" display as "Reportvaw.pdf".
    expect(expandFileName('%T',{...context,title:'Report\u202efdp\u200f\u2066x\ufeff'})).toBe('Report-fdp--x');
  });
  it('keeps names within 200 UTF-8 bytes without splitting a character',()=>{
    const bytes=(name:string)=>new TextEncoder().encode(name).length;
    expect(expandFileName('%T',{...context,title:'x'.repeat(300)})).toHaveLength(200);
    expect(expandFileName('%T',{...context,title:'🎸'.repeat(130)})).toBe('🎸'.repeat(50));
    const japanese=expandFileName('%T',{...context,title:'楽'.repeat(130)});expect(japanese).toBe('楽'.repeat(66));expect(bytes(japanese)).toBe(198);
    expect(expandFileName('%T',{...context,title:`${'x'.repeat(199)}. y`})).toBe('x'.repeat(199));
    expect(expandFileName('',context)).toBe('TabPlayer-export');
    expect(expandFileName('...',context)).toBe('TabPlayer-export');
  });
  it('fills empty titles and track names',()=>{
    expect(expandFileName('%T %t',{...context,title:'  ',trackName:''})).toBe('Untitled Track 3');
  });
});

it('takes track tokens from the first selected track and counts every score track',()=>{
  const score=new model.Score();score.title='Song';score.addMasterBar(new model.MasterBar());
  for(const name of ['Bass','Lead','Keys']){const track=new model.Track();track.name=name;score.addTrack(track);}
  expect(fileNameContext(score,{tracks:[2,1],range:null},now)).toEqual({title:'Song',trackName:'Lead',trackNumber:2,trackCount:3,now});
});

it('previews the saved name with the extension appended only when it is missing',()=>{
  expect(withExtension('Anatole','pdf')).toBe('Anatole.pdf');
  expect(withExtension('Anatole.PDF','pdf')).toBe('Anatole.PDF');
  expect(withExtension('Live.mid','mid')).toBe('Live.mid');
  expect(withExtension('Gtr. 1','pdf')).toBe('Gtr. 1.pdf');
  expect(withExtension('Stems','')).toBe('Stems');
});
