// @vitest-environment jsdom
import { fireEvent,render,screen } from '@testing-library/react';
import { describe,expect,it } from 'vitest';
import { blankProject } from '../project';
import { AUTO_DURATION_UNFIT,DEFAULT_INPUT_PREFERENCES,InputPreferencesPanel,applyInOrder,autoDurationEdit,autoDurationSkip,entryAfterWrite,numpadDurationEdit,numpadKey,readInputPreferences,writeInputPreferences,type EntryBeat,type InputPreferences } from './input-preferences';

const target={track:0,staff:0,bar:1,voice:0,beat:2};
const key=(code:string,extra={},value=code.replace(/^Numpad(\d)$/,'$1').replace('NumpadDecimal','.'))=>({key:value,code,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...extra});
const on:InputPreferences={autoDuration:true,numpadDurations:true,pasteDiagrams:true};
const beat=(extra:Partial<EntryBeat>={}):EntryBeat=>({duration:4,dots:0,isEmpty:false,notes:[],...extra});
const store=(initial?:string)=>{const values=new Map<string,string>();if(initial!==undefined)values.set('tabplayer.input.preferences',initial);return {values,getItem:(name:string)=>values.get(name)??null,setItem:(name:string,value:string)=>{values.set(name,value);}};};

describe('stored preferences',()=>{
  it('defaults, round-trips and repairs one field at a time',()=>{
    expect(readInputPreferences(store())).toEqual(DEFAULT_INPUT_PREFERENCES);
    expect(DEFAULT_INPUT_PREFERENCES).toEqual({autoDuration:false,numpadDurations:false,pasteDiagrams:true});
    const kept=store();writeInputPreferences(on,kept);expect(readInputPreferences(kept)).toEqual(on);
    expect(readInputPreferences(store('{"autoDuration":true,"numpadDurations":"yes","pasteDiagrams":false}'))).toEqual({autoDuration:true,numpadDurations:false,pasteDiagrams:false});
    expect(readInputPreferences(store('not json'))).toEqual(DEFAULT_INPUT_PREFERENCES);
    expect(readInputPreferences(store('[1]'))).toEqual(DEFAULT_INPUT_PREFERENCES);
    const broken={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
    expect(readInputPreferences(broken)).toEqual(DEFAULT_INPUT_PREFERENCES);expect(()=>writeInputPreferences(on,broken)).not.toThrow();
  });
});

describe('keypad durations',()=>{
  it('maps keypad 1-7 to whole through sixty-fourth only when enabled',()=>{
    expect([1,2,3,4,5,6,7].map(n=>numpadKey(key(`Numpad${n}`),on))).toEqual([1,2,4,8,16,32,64].map(duration=>({duration})));
    expect(numpadKey(key('Numpad3'),DEFAULT_INPUT_PREFERENCES)).toBeNull();
    expect(numpadKey(key('NumpadDecimal'),on)).toEqual({dot:true});
  });
  it('leaves NumLock-off keypad keys to navigation',()=>{
    for(const [code,value] of [['Numpad1','End'],['Numpad2','ArrowDown'],['Numpad4','ArrowLeft'],['Numpad6','ArrowRight'],['Numpad7','Home'],['NumpadDecimal','Delete']])expect(numpadKey(key(code,{},value),on)).toBeNull();
    expect(numpadKey(key('NumpadDecimal',{},','),on)).toEqual({dot:true});
  });
  it('leaves other keys and modified keys alone',()=>{
    for(const code of ['Digit3','Numpad0','Numpad8','Numpad9','NumpadAdd','Enter'])expect(numpadKey(key(code),on)).toBeNull();
    for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true}])expect(numpadKey(key('Numpad3',extra),on)).toBeNull();
  });
  it('edits the selected beat once, keeping its dots, and records the entry duration',()=>{
    expect(numpadDurationEdit({duration:8},target,beat({dots:1}))).toEqual({command:{type:'setDuration',target,duration:8,dots:1},entry:{duration:8,dots:1}});
    expect(numpadDurationEdit({dot:true},target,beat({duration:16}))).toEqual({command:{type:'setDuration',target,duration:16,dots:1},entry:{duration:16,dots:1}});
    expect(numpadDurationEdit({dot:true},target,beat({dots:1}))?.command).toEqual({type:'setDuration',target,duration:4,dots:0});
  });
  it('makes no edit when the rhythm would not change',()=>{
    expect(numpadDurationEdit({duration:4},target,beat())).toBeNull();
    expect(numpadDurationEdit({duration:4},target,beat({dots:1}))).toBeNull();
    expect(numpadDurationEdit({duration:8},target,beat({duration:8,dots:0}))).toBeNull();
  });
  it('refuses placeholders and tuplets',()=>{
    expect(numpadDurationEdit({duration:8},target,beat({isEmpty:true}))).toBeNull();
    expect(numpadDurationEdit({duration:8},target,beat({tupletNumerator:3}))).toBeNull();
  });
});

describe('auto-duration',()=>{
  const entry={duration:8,dots:0};
  it('sets the entry duration on a differing rest',()=>{
    expect(autoDurationEdit(on,target,beat(),entry)).toEqual({type:'setDuration',target,duration:8,dots:0});
    expect(autoDurationEdit(on,target,beat({dots:1,duration:8}),entry)).toEqual({type:'setDuration',target,duration:8,dots:0});
  });
  it('does nothing when off, without an entry, on matching, noted, placeholder or tuplet beats',()=>{
    expect(autoDurationEdit({...on,autoDuration:false},target,beat(),entry)).toBeNull();
    expect(autoDurationEdit(on,target,beat(),null)).toBeNull();
    expect(autoDurationEdit(on,target,beat({duration:8}),entry)).toBeNull();
    expect(autoDurationEdit(on,target,beat({notes:[{}] as unknown as []}),entry)).toBeNull();
    expect(autoDurationEdit(on,target,beat({isEmpty:true}),entry)).toBeNull();
    expect(autoDurationEdit(on,target,beat({tupletNumerator:3}),entry)).toBeNull();
    expect(autoDurationEdit(on,target,null,entry)).toBeNull();
  });
  it('remembers the rhythm of the last beat written on',()=>{
    expect(entryAfterWrite(beat({duration:16,dots:1}),null)).toEqual({duration:16,dots:1});
    expect(entryAfterWrite(beat({isEmpty:true}),{duration:8,dots:0})).toEqual({duration:8,dots:0});
    expect(entryAfterWrite(null,null)).toBeNull();
  });
});

describe('auto-duration safety',()=>{
  const entry={duration:8,dots:0},first={track:0,staff:0,bar:0,voice:0,beat:0};
  it('names why it skipped a placeholder or tuplet rest',()=>{
    expect(autoDurationSkip(on,beat({isEmpty:true}),entry)).toMatch(/placeholder/);
    expect(autoDurationSkip(on,beat({tupletNumerator:3}),entry)).toMatch(/tuplet/);
    expect(autoDurationSkip(on,beat(),entry)).toBeNull();
    expect(autoDurationSkip(on,beat({isEmpty:true,duration:8}),entry)).toBeNull();
    expect(autoDurationSkip({...on,autoDuration:false},beat({isEmpty:true}),entry)).toBeNull();
    expect(AUTO_DURATION_UNFIT).toMatch(/does not fit/);
  });
  it('applyInOrder accepts a valid pair and refuses a pair whose note is out of range, so nothing is half done',()=>{
    const project=blankProject(),rhythm={type:'setDuration' as const,target:first,duration:8,dots:0};
    expect(applyInOrder(project,[rhythm,{type:'setNote',target:first,string:6,fret:5}])).toBe(true);
    expect(applyInOrder(project,[rhythm,{type:'setNote',target:first,string:6,fret:99}])).toBe(false);
    expect(applyInOrder(project,[{type:'setNote',target:first,string:6,fret:99}])).toBe(false);
    expect(applyInOrder(project,[{...rhythm,duration:1},{type:'setNote',target:first,string:6,fret:5}])).toBe(false);
  });
});

describe('InputPreferencesPanel',()=>{
  it('shows each choice and reports a change',()=>{
    const changes:Partial<InputPreferences>[]=[],previews:boolean[]=[];
    render(<InputPreferencesPanel preferences={DEFAULT_INPUT_PREFERENCES} onChange={change=>changes.push(change)} preview onPreview={play=>previews.push(play)}/>);
    expect((screen.getByLabelText('Play notes while editing') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/^Auto-duration/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/^Paste includes chord diagrams/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Auto-duration/));fireEvent.click(screen.getByLabelText(/^Keypad sets duration/));fireEvent.click(screen.getByLabelText(/^Paste includes chord diagrams/));fireEvent.click(screen.getByLabelText('Play notes while editing'));
    expect(changes).toEqual([{autoDuration:true},{numpadDurations:true},{pasteDiagrams:false}]);expect(previews).toEqual([false]);
  });
});
