import { expect,it } from 'vitest';
import { authoredTemposOf,fixedLimits,PracticeError,practiceForBacking,practiceProblem,validatePractice,type AuthoredTempos } from './practice';
import { DEFAULT_PRACTICE,type PracticeSettings } from './practice-types';
import protocol from '../../tests/practice-protocol.json';

const settings=():PracticeSettings=>structuredClone(DEFAULT_PRACTICE);
function validate(value:unknown,authored:AuthoredTempos|null=null){validatePractice(value as PracticeSettings,authored);}
const authoredOf=(item:{hasBacking:boolean;authoredBpm?:AuthoredTempos}):AuthoredTempos|null=>item.hasBacking?item.authoredBpm??null:null;

for(const item of protocol.valid)it(`shared_protocol_accepts_${item.name}`,()=>{const before=structuredClone(item.settings);expect(()=>validate(item.settings,authoredOf(item))).not.toThrow();expect(item.settings).toEqual(before);});
for(const item of protocol.invalid)it(`shared_protocol_rejects_${item.name}`,()=>{const before=structuredClone(item.settings);expect(()=>validate(item.settings,authoredOf(item))).toThrow();expect(item.settings).toEqual(before);});

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
it('follows_a_fixed_tempo_with_a_backing_only_inside_10_to_300_percent_of_every_authored_tempo',()=>{
  const fixed=(bpm:number):PracticeSettings=>({tempo:{kind:'fixed',bpm},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}});
  const steady:AuthoredTempos={min:120,max:120},changing:AuthoredTempos={min:60,max:120};
  for(const [bpm,authored] of [[120,steady],[12,steady],[300,{min:100,max:100}],[12,changing],[180,changing]] as const)expect(()=>validatePractice(fixed(bpm),authored)).not.toThrow();
  for(const [bpm,authored] of [[11.9,steady],[300,{min:99.9,max:99.9}],[11.9,changing],[181,changing]] as const)expect(()=>validatePractice(fixed(bpm),authored)).toThrow(PracticeError);
  expect(()=>validatePractice(fixed(181),changing)).toThrow('Fixed tempo 181 BPM would stretch the backing track outside 10% to 300% of its speed. For this score choose 12 to 180 BPM. A muted backing counts too.');
  expect(()=>validatePractice(fixed(100),{min:10,max:400})).toThrow('No fixed tempo suits this score');
  expect(fixedLimits(changing)).toEqual({low:12,high:180});expect(fixedLimits({min:10,max:400})).toBeNull();expect(fixedLimits({min:33,max:33})).toEqual({low:10,high:99});
  expect(()=>validatePractice(fixed(9.9),null)).toThrow('Fixed tempo must be between 10 and 300 BPM.');
});
it('the_range_a_refusal_names_is_exactly_the_range_that_is_accepted',()=>{
  const accepts=(bpm:number,authored:{min:number;max:number})=>{try{validatePractice({...settings(),tempo:{kind:'fixed',bpm}},authored);return true;}catch{return false;}};
  const tenths=(n:number)=>Math.round(n*10)/10,failures:string[]=[];let checked=0;
  const maxima=[...Array.from({length:2901},(_,i)=>100+i).filter(n=>n%3===1||n===121),33.3,121.5,99.9,10.5,300.1];
  for(const max of maxima)for(const ratio of [1,.75,.5,.1,.034])for(const min of [max*ratio,Math.round(max*ratio)]){
    const authored={min:Math.min(min,max),max};if(authored.min<=0)continue;
    const limits=fixedLimits(authored),tag=`${authored.min}/${authored.max}`;
    if(!limits){if(accepts(100,authored))failures.push(`${tag}: no range yet 100 accepted`);continue;}
    const {low,high}=limits;checked++;
    for(const bpm of [low,tenths((low+high)/2),high])if(!accepts(bpm,authored))failures.push(`${tag}: ${bpm} in ${low}-${high} refused`);
    // Inside the stated range the stretch really is within 10% to 300% of the speed at the slowest and fastest tempo.
    for(const bpm of [low,high])if(bpm/authored.min>3+1e-6||bpm/authored.max<.1-1e-7)failures.push(`${tag}: ${bpm} stretches outside`);
    if(low-.1>=10&&accepts(tenths(low-.1),authored))failures.push(`${tag}: ${tenths(low-.1)} accepted under ${low}`);
    if(high+.1<=300&&accepts(tenths(high+.1),authored))failures.push(`${tag}: ${tenths(high+.1)} accepted over ${high}`);
  }
  expect(failures).toEqual([]);expect(checked).toBeGreaterThan(3000);
  expect(fixedLimits({min:121,max:121})).toEqual({low:12.1,high:300});expect(accepts(12.1,{min:121,max:121})).toBe(true);expect(()=>validatePractice({...settings(),tempo:{kind:'fixed',bpm:12}},{min:121,max:121})).toThrow('choose 12.1 to 300 BPM');
});
it('measures_the_authored_tempos_that_govern_the_played_range',()=>{
  const tempos=[{tick:0,bpm:120},{tick:3840,bpm:60},{tick:7680,bpm:30}];
  expect(authoredTemposOf({tempos,durationTick:7680})).toEqual({min:60,max:120});
  expect(authoredTemposOf({tempos,durationTick:7680,playbackEndTick:3840})).toEqual({min:120,max:120});
  expect(authoredTemposOf({tempos:[{tick:0,bpm:90}],durationTick:0})).toEqual({min:90,max:90});
});
it('replaces_a_fixed_tempo_the_backing_cannot_follow_and_detaches_normalized_copies',()=>{
  const fixed:PracticeSettings={tempo:{kind:'fixed',bpm:100.5},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}};
  const before=structuredClone(fixed),result=practiceForBacking(fixed,{min:2000,max:2000});
  expect(result).toEqual({settings:{tempo:{kind:'relative',ratio:1},metronome:{enabled:false,volume:0,visual:true},countIn:{bars:2,betweenLoops:true}},notice:'fixed_tempo_backing_range'});
  expect(fixed).toEqual(before);result.settings.metronome.visual=false;result.settings.countIn.bars=0;expect(fixed).toEqual(before);
  for(const authored of [null,{min:120,max:120}])for(const tempo of [{kind:'relative',ratio:1.23},{kind:'progressive',start:.5,end:1,step:.2,repetitions:2}] as const){const value={...settings(),tempo};const copy=practiceForBacking(value,authored);expect(copy).toEqual({settings:value,notice:null});expect(copy.settings).not.toBe(value);expect(copy.settings.tempo).not.toBe(value.tempo);expect(copy.settings.metronome).not.toBe(value.metronome);expect(copy.settings.countIn).not.toBe(value.countIn);}
  expect(practiceForBacking(fixed,null)).toEqual({settings:fixed,notice:null});
  expect(practiceForBacking(fixed,{min:120,max:120})).toEqual({settings:fixed,notice:null});
  expect(()=>practiceForBacking({...fixed,tempo:{kind:'fixed',bpm:0}},{min:120,max:120})).toThrow();
});

it('accepts settings with or without a metronome sound and refuses unknown sounds',()=>{
  const base=structuredClone(DEFAULT_PRACTICE);delete base.metronome.sound;
  expect(()=>validatePractice(base,null)).not.toThrow();
  for(const sound of ['beep','woodblock','cowbell','stick'] as const)expect(()=>validatePractice({...base,metronome:{...base.metronome,sound}},null)).not.toThrow();
  expect(()=>validatePractice({...base,metronome:{...base.metronome,sound:'gong' as never}},null)).toThrow('Invalid metronome sound.');
  expect(()=>validatePractice({...base,metronome:{...base.metronome,sound:undefined}},null)).toThrow('Invalid metronome sound.');
});

it('accepts_an_optional_whole_key_shift_from_minus_twelve_to_twelve_and_refuses_the_rest',()=>{
  for(const tonality of [-12,0,7,12])expect(()=>validatePractice({...settings(),tonality},null)).not.toThrow();
  for(const tonality of [-13,13,1.5,NaN,Infinity,'2',null,undefined])expect(()=>validatePractice({...settings(),tonality} as never,null)).toThrow();
  expect(()=>validatePractice({...settings(),tonality:13},null)).toThrow('Key shift');
});
it('practice_for_backing_keeps_the_key_shift_and_adds_none_when_absent',()=>{
  const shifted={...settings(),tonality:-5},copy=practiceForBacking(shifted,{min:120,max:120});
  expect(copy.settings.tonality).toBe(-5);expect(copy.settings).toEqual(shifted);
  expect(Object.hasOwn(practiceForBacking(settings(),{min:120,max:120}).settings,'tonality')).toBe(false);
  const fixed:PracticeSettings={...settings(),tempo:{kind:'fixed',bpm:90},tonality:3};
  expect(practiceForBacking(fixed,{min:2000,max:2000}).settings).toEqual({...settings(),tonality:3});
});

it('describes_a_failed_key_change_in_the_language_of_the_interface_and_never_shows_a_raw_error',()=>{
  const t=(key:string)=>`<${key}>`;
  expect(practiceProblem(new PracticeError('tonality'),t as never)).toBe('<practice.error_tonality>');
  expect(practiceProblem(new Error('Practice settings acknowledgement is pending.'),t as never)).toBe('<palette.error_key_failed>');
  expect(practiceProblem('boom',t as never)).toBe('<palette.error_key_failed>');
});
