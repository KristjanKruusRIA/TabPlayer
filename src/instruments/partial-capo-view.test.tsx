// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { formatPitch } from '../tuning';
import { InstrumentView } from './InstrumentView';
import { TrackSettingsPanel } from '../workstation/TrackSettingsPanel';
import { setPartialCapo } from '../editor/partial-capo';

afterEach(()=>{cleanup();localStorage.clear();});
const target={track:0,staff:0,bar:0,voice:0,beat:0};
/** Standard guitar with capo 2 and a partial capo at fret 5 over the three lowest strings, holding a note per string at fret 3. */
function build(partial=true) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.playbackInfo.program=25;
  staff.stringTuning.tunings=[64,59,55,50,45,40];staff.capo=2;if(partial)setPartialCapo(staff,{fret:5,strings:[1,2,3]});
  track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Quarter;
  for(const string of [1,2,3,4,5,6]){const note=new model.Note();note.string=string;note.fret=3;beat.addNote(note);}
  voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());return score;
}
const fretboard=(score:model.Score,entry=false)=>render(<InstrumentView score={score} track={0} staff={0} notes={[]} entry={entry?{target,busy:false,onEdit:vi.fn()}:undefined}/>);

it('names each open string and the entry targets with the capo that acts on that string',()=>{
  fretboard(build(),true);
  expect(screen.getByText(/Partial capo 5 on strings 1, 2, 3 · fret numbers on those strings relative to it/)).toBeInTheDocument();
  expect(document.querySelector('.instrument-detail')!.textContent).toContain(`Open ${[66,61,57,55,50,45].map(formatPitch).join(' ')}`);
  // The highest string is covered by the capo only; the lowest by the partial capo.
  expect(screen.getByRole('button',{name:`Remove string 6, fret 3 (${formatPitch(69)})`})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:`Remove string 1, fret 3 (${formatPitch(48)})`})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:`Remove string 3, fret 3 (${formatPitch(58)})`})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:`Remove string 4, fret 3 (${formatPitch(60)})`})).toBeInTheDocument();
});
it('titles each string row with its own open pitch and leaves a plain capo staff unchanged',()=>{
  const {container}=fretboard(build());
  const title=(string:number)=>container.querySelector(`[data-string-row="${string}"] title`)!.textContent;
  expect(title(1)).toBe(`String 1 · ${formatPitch(45)}`);expect(title(4)).toBe(`String 4 · ${formatPitch(57)}`);expect(title(6)).toBe(`String 6 · ${formatPitch(66)}`);
  cleanup();
  const plain=fretboard(build(false)).container;
  expect(plain.querySelector('[data-string-row="1"] title')!.textContent).toBe(`String 1 · ${formatPitch(42)}`);
  expect(screen.queryByText(/Partial capo/)).toBeNull();
});
it('clicking a fret writes the fret on its own string, so the audition and the plan agree',()=>{
  const onEdit=vi.fn();
  render(<InstrumentView score={build()} track={0} staff={0} notes={[]} entry={{target,busy:false,onEdit}}/>);
  fireEvent.click(screen.getByRole('button',{name:`String 2, fret 7 (${formatPitch(45+5+7)})`}));
  expect(onEdit).toHaveBeenCalledWith({type:'setNote',target,string:2,fret:7},{string:2,fret:7});
});

/** The partial capo lives in the Capo section of the track's Tuning dialog. */
const panel=(score:model.Score,onEdit=vi.fn(),props:{locked?:boolean;busy?:boolean}={})=>{render(<TrackSettingsPanel score={score} selected={0} busy={false} onEdit={onEdit} {...props}/>);if(!props.locked)fireEvent.click(screen.getByRole('button',{name:/^Edit tuning/}));return onEdit;};
const dialog=()=>within(screen.getByRole('dialog',{name:'Tuning'}));
const keep=()=>dialog().getByRole('button',{name:'Keep fingering'});
// Applying the values a staff already has records nothing, so each press first changes the capo; the dialog closes when it lands and is reopened.
let capoStep=10;
const applied=(onEdit:ReturnType<typeof vi.fn>)=>{capoStep+=1;fireEvent.change(dialog().getByLabelText('Capo'),{target:{value:String(capoStep)}});fireEvent.click(keep());const settings=onEdit.mock.calls.at(-1)![0].settings;if(!screen.queryByRole('dialog'))fireEvent.click(screen.getByRole('button',{name:/^Edit tuning/}));return settings;};
const fretField=()=>dialog().getByLabelText('Partial capo fret');
it('shows the staff partial capo and sends it only once changed',()=>{
  const onEdit=panel(build());
  expect(fretField()).toHaveValue(5);
  const strings=()=>within(dialog().getByRole('group',{name:'Partial capo strings'}));
  expect(strings().getAllByRole('checkbox').map(box=>(box as HTMLInputElement).checked)).toEqual([false,false,false,true,true,true]);
  // Untouched, the command omits it and so keeps the staff's own.
  expect(applied(onEdit)).not.toHaveProperty('partialCapo');
  fireEvent.click(strings().getByRole('checkbox',{name:/String 6/}));
  expect(applied(onEdit).partialCapo).toEqual({fret:5,strings:[1,2,3,6]});
});
it('leaves the command unchanged for a staff with no partial capo until one is chosen',()=>{
  const onEdit=panel(build(false));
  fireEvent.change(fretField(),{target:{value:'7'}});
  // Typing alone commits nothing, and a fret without strings is a draft that holds the apply buttons back.
  fireEvent.blur(fretField());
  expect(dialog().getAllByRole('alert').map(node=>node.textContent).join(' ')).toContain('Choose the strings the partial capo covers.');
  fireEvent.change(dialog().getByLabelText('Capo'),{target:{value:'3'}});fireEvent.click(keep());
  expect(onEdit).not.toHaveBeenCalled();expect(screen.getByRole('dialog',{name:'Tuning'})).toBeInTheDocument();
  fireEvent.click(dialog().getByRole('checkbox',{name:/String 6/}));fireEvent.click(dialog().getByRole('checkbox',{name:/String 5/}));
  expect(applied(onEdit).partialCapo).toEqual({fret:7,strings:[5,6]});
});
it('commits the fret with Enter, and clearing it clears the partial capo',()=>{
  const onEdit=panel(build());
  fireEvent.change(fretField(),{target:{value:'9'}});fireEvent.keyDown(fretField(),{key:'Enter'});expect(applied(onEdit).partialCapo).toEqual({fret:9,strings:[1,2,3]});
  for(const string of [1,2,3])fireEvent.click(dialog().getByRole('checkbox',{name:new RegExp(`^String ${string} `)}));
  fireEvent.change(fretField(),{target:{value:''}});fireEvent.blur(fretField());expect(applied(onEdit).partialCapo).toEqual({fret:0,strings:[]});
});
it('says when the capo already covers the partial capo',()=>{
  panel(build());
  fireEvent.change(fretField(),{target:{value:'1'}});
  expect(dialog().getByText(/capo at fret 2 is higher/)).toBeInTheDocument();
});
it('is locked with the rest of the staff settings: a finalized score cannot open the dialog',()=>{
  const onEdit=panel(build(),vi.fn(),{locked:true});
  expect(screen.getByRole('button',{name:/^Edit tuning/})).toBeDisabled();expect(onEdit).not.toHaveBeenCalled();
});
it('sends nothing when the fret is only tabbed through on an untouched staff',()=>{
  const onEdit=panel(build());
  fireEvent.focus(fretField());fireEvent.blur(fretField());
  expect(applied(onEdit)).not.toHaveProperty('partialCapo');
});
it('keeps the last valid partial capo and holds the apply buttons back while the fret on screen is out of range',()=>{
  const onEdit=panel(build());
  fireEvent.change(fretField(),{target:{value:'9'}});fireEvent.blur(fretField());expect(applied(onEdit).partialCapo).toEqual({fret:9,strings:[1,2,3]});
  const calls=onEdit.mock.calls.length;
  fireEvent.change(fretField(),{target:{value:'200'}});fireEvent.blur(fretField());
  expect(dialog().getAllByRole('alert').map(node=>node.textContent).join(' ')).toContain('1 to 127');
  fireEvent.submit(keep().closest('form')!);
  expect(onEdit.mock.calls.length).toBe(calls);expect(screen.getByRole('dialog',{name:'Tuning'})).toBeInTheDocument();
  fireEvent.change(fretField(),{target:{value:'11'}});fireEvent.blur(fretField());expect(applied(onEdit).partialCapo).toEqual({fret:11,strings:[1,2,3]});
});

it('names the partial capo and sounds the covered strings of a chord diagram by it',async()=>{
  const {ChordDiagramPreview}=await import('../harmony/ChordDiagramPreview');
  const staff=new model.Staff();staff.stringTuning.tunings=[64,40];staff.capo=2;setPartialCapo(staff,{fret:5,strings:[1]});
  const chord={name:'Two',nameMode:'manual' as const,recipe:null,firstFret:0,frets:[0,0],fingers:[-2,-2],barreFrets:[],showName:true,showDiagram:true,showFingering:true};
  render(<ChordDiagramPreview chord={chord} staff={staff} highlightRoot={false} onToggle={null}/>);
  expect(screen.getByText(/capo 2 · partial capo 5 on string 1 · sounding offset/)).toBeInTheDocument();
  expect(screen.getByLabelText(`String 2 open: ${formatPitch(40+5)}`)).toBeInTheDocument();expect(screen.getByLabelText(`String 1 open: ${formatPitch(64+2)}`)).toBeInTheDocument();
});
