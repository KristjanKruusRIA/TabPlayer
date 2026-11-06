import { expect,it } from 'vitest';
import { practiceForBacking,validatePractice } from './practice';
import { DEFAULT_PRACTICE,type PracticeSettings } from './practice-types';
import protocol from '../../tests/practice-protocol.json';

const settings=():PracticeSettings=>structuredClone(DEFAULT_PRACTICE);
function validate(value:unknown,backing=false){validatePractice(value as PracticeSettings,backing);}

for(const item of protocol.valid)it(`shared_protocol_accepts_${item.name}`,()=>{const before=structuredClone(item.settings);expect(()=>validate(item.settings,item.hasBacking)).not.toThrow();expect(item.settings).toEqual(before);});
for(const item of protocol.invalid)it(`shared_protocol_rejects_${item.name}`,()=>{const before=structuredClone(item.settings);expect(()=>validate(item.settings,item.hasBacking)).toThrow();expect(item.settings).toEqual(before);});

it('accepts_relative_fixed_and_progressive_bounds_without_mutating_inputs',()=>{
  const tempos=[{kind:'relative',ratio:.1},{kind:'relative',ratio:3},{kind:'fixed',bpm:10},{kind:'fixed',bpm:300},{kind:'fixed',bpm:100.5},{kind:'progressive',start:.1,end:3,step:2.9,repetitions:100},{kind:'progressive',start:1,end:1,step:.01,repetitions:1}];
  for(const tempo of tempos){const value={...settings(),tempo};const before=structuredClone(value);expect(()=>validate(value)).not.toThrow();expect(value).toEqual(before);}
  for(const volume of [0,1])for(const bars of [0,16])expect(()=>validate({...settings(),metronome:{enabled:true,volume,visual:true},countIn:{bars,betweenLoops:true}})).not.toThrow();
});
it('rejects_unknown_missing_and_non_object_shapes_at_each_level',()=>{
  const invalid:unknown[]=[null,[],true,{}, {...settings(),unknown:1}, {...settings(),tempo:null}, {...settings(),tempo:[]}, {...settings(),tempo:{kind:'relative'}}, {...settings(),tempo:{kind:'relative',ratio:1,bpm:120}}, {...settings(),tempo:{kind:'unknown',ratio:1}}, {...settings(),metronome:{enabled:false,volume:.4}}, {...settings(),metronome:{enabled:false,volume:.4,visual:false,extra:0}}, {...settings(),countIn:{bars:0}}, {...settings(),countIn:{bars:0,betweenLoops:false,extra:0}}];
  for(const value of invalid){const before=structuredClone(value);expect(()=>validate(value)).toThrow();expect(value).toEqual(before);}
});
it('rejects_out_of_bounds_nonfinite_fractional_integer_and_nonboolean_values_atomically',()=>{
  const invalid:unknown[]=[];
  for(const ratio of [.099,3.001,NaN,Infinity,-Infinity,'1'])invalid.push({...settings(),tempo:{kind:'relative',ratio}});
  for(const bpm of [9.99,300.01,NaN,Infinity,'120'])invalid.push({...settings(),tempo:{kind:'fixed',bpm}});
  for(const patch of [{start:.09},{start:3.01},{end:.09},{end:3.01},{end:.4},{step:0},{step:2.91},{step:Infinity},{repetitions:0},{repetitions:101},{repetitions:1.5},{repetitions:NaN}])invalid.push({...settings(),tempo:{kind:'progressive',start:.5,end:1,step:.2,repetitions:2,...patch}});
  for(const patch of [{enabled:0},{enabled:'false'},{volume:-.01},{volume:1.01},{volume:NaN},{visual:1}])invalid.push({...settings(),metronome:{enabled:false,volume:.4,visual:false,...patch}});
  for(const patch of [{bars:-1},{bars:17},{bars:.5},{bars:NaN},{bars:Infinity},{betweenLoops:0}])invalid.push({...settings(),countIn:{bars:0,betweenLoops:false,...patch}});
  for(const value of invalid){const before=structuredClone(value);expect(()=>validate(value)).toThrow();expect(value).toEqual(before);}
});
it('rejects_fixed_with_any_backing_and_detaches_normalized_copies',()=>{
  const fixed:PracticeSettings={tempo:{kind:'fixed',bpm:100.5},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};
  expect(()=>validatePractice(fixed,true)).toThrow('Fixed tempo is unavailable while a backing track is present.');
  const before=structuredClone(fixed),result=practiceForBacking(fixed,true);
  expect(result).toEqual({settings:{tempo:{kind:'relative',ratio:1},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}},notice:'Fixed tempo disabled because this score has backing audio.'});
  expect(fixed).toEqual(before);result.settings.metronome.visual=false;result.settings.countIn.bars=0;expect(fixed).toEqual(before);
  for(const hasBacking of [false,true])for(const tempo of [{kind:'relative',ratio:1.23},{kind:'progressive',start:.5,end:1,step:.2,repetitions:2}] as const){const value={...settings(),tempo};const copy=practiceForBacking(value,hasBacking);expect(copy).toEqual({settings:value,notice:null});expect(copy.settings).not.toBe(value);expect(copy.settings.tempo).not.toBe(value.tempo);expect(copy.settings.metronome).not.toBe(value.metronome);expect(copy.settings.countIn).not.toBe(value.countIn);}
  expect(practiceForBacking(fixed,false)).toEqual({settings:fixed,notice:null});
  expect(()=>practiceForBacking({...fixed,tempo:{kind:'fixed',bpm:0}},true)).toThrow();
});

it('accepts settings with or without a metronome sound and refuses unknown sounds',()=>{
  const base=structuredClone(DEFAULT_PRACTICE);delete base.metronome.sound;
  expect(()=>validatePractice(base,false)).not.toThrow();
  for(const sound of ['beep','woodblock','cowbell','stick'] as const)expect(()=>validatePractice({...base,metronome:{...base.metronome,sound}},false)).not.toThrow();
  expect(()=>validatePractice({...base,metronome:{...base.metronome,sound:'gong' as never}},false)).toThrow('Invalid metronome sound.');
  expect(()=>validatePractice({...base,metronome:{...base.metronome,sound:undefined}},false)).toThrow('Invalid metronome sound.');
});
