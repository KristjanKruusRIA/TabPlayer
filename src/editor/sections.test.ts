import { expect,it } from 'vitest';
import { model,Settings } from '@coderline/alphatab';
import { music } from './fixtures';
import { listSections,neighbourSection,sectionAt } from './sections';

const named=(labels:Record<number,string>)=>{
  const score=music();
  for(const [bar,text] of Object.entries(labels)){const section=new model.Section();section.text=text;score.masterBars[Number(bar)].section=section;}
  score.finish(new Settings());return score;
};

it('lists named sections in score order and skips blank labels',()=>{
  expect(listSections(named({0:'Intro',2:'  Chorus ',3:'   '}))).toEqual([{bar:0,name:'Intro'},{bar:2,name:'Chorus'}]);
  expect(listSections(music())).toEqual([]);
});

it('finds the section a measure is in',()=>{
  const sections=listSections(named({1:'Verse',3:'Chorus'}));
  expect([0,1,2,3].map(bar=>sectionAt(sections,bar))).toEqual([-1,0,0,1]);
});

it('moves to the previous or next section start, and stays put at the ends',()=>{
  const sections=listSections(named({0:'Intro',2:'Verse',3:'Chorus'}));
  expect(neighbourSection(sections,1,'next')).toBe(2);
  expect(neighbourSection(sections,2,'next')).toBe(3);
  expect(neighbourSection(sections,3,'next')).toBeNull();
  expect(neighbourSection(sections,3,'previous')).toBe(2);
  expect(neighbourSection(sections,2,'previous')).toBe(0);
  expect(neighbourSection(sections,0,'previous')).toBeNull();
  expect(neighbourSection([],0,'next')).toBeNull();
});
