// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { formatPitch } from '../tuning';
import { InstrumentView } from './InstrumentView';

afterEach(()=>{cleanup();localStorage.clear();});
const guitar=[64,59,55,50,45,40], target={track:0,staff:0,bar:0,voice:0,beat:0};
interface Spec { tuning?:number[]; program?:number; percussion?:boolean; frets?:[number,number][]; pitches?:number[]; articulations?:number[]; capo?:number; transposition?:number; empty?:boolean; custom?:number[] }
/** One beat holding the given notes: string/fret pairs, written pitches or percussion articulation ids. */
function build({tuning=guitar,program=25,percussion=false,frets=[],pitches=[],articulations=[],capo=0,transposition=0,empty=false,custom}:Spec={}) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name=percussion?'Drums':'Track';track.playbackInfo.program=program;
  staff.stringTuning.tunings=[...tuning];staff.isPercussion=percussion;staff.capo=capo;staff.transpositionPitch=transposition;
  if(custom)track.percussionArticulations=custom.map(out=>new model.InstrumentArticulation('Custom',0,out,model.MusicFontSymbol.NoteheadXBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole));
  track.addStaff(staff);score.addTrack(track);score.addMasterBar(new model.MasterBar());
  if(percussion)track.playbackInfo.primaryChannel=track.playbackInfo.secondaryChannel=9;
  const bar=new model.Bar(),voice=new model.Voice(),beat=new model.Beat();beat.duration=model.Duration.Quarter;beat.isEmpty=empty;
  for(const [string,fret] of frets){const note=new model.Note();note.string=string;note.fret=fret;beat.addNote(note);}
  for(const pitch of pitches){const note=new model.Note();note.octave=Math.floor(pitch/12);note.tone=pitch%12;beat.addNote(note);}
  for(const id of articulations){const note=new model.Note();note.percussionArticulation=id;beat.addNote(note);}
  voice.addBeat(beat);bar.addVoice(voice);staff.addBar(bar);score.finish(new Settings());return score;
}
function show(score:model.Score,entry:{target?:typeof target|null;busy?:boolean;string?:number}={}) {
  const onEdit=vi.fn(),utils=render(<InstrumentView score={score} track={0} staff={0} notes={[]} entry={{target:'target' in entry?entry.target!:target,busy:entry.busy??false,string:entry.string,onEdit}}/>);
  return {onEdit,...utils};
}
const button=(name:string)=>screen.getByRole('button',{name});
const keysMode=()=>fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'keys'}});

it('writes a note on a free fret and names each target with its sounding pitch',()=>{
  const {onEdit}=show(build({frets:[[1,0]]}));
  expect(screen.getByRole('group',{name:'Guitar fretboard'})).toBeInTheDocument();expect(screen.queryByRole('img',{name:'Guitar fretboard'})).toBeNull();
  fireEvent.click(button(`String 6, fret 3 (${formatPitch(67)})`));
  expect(onEdit).toHaveBeenCalledTimes(1);expect(onEdit).toHaveBeenCalledWith({type:'setNote',target,string:6,fret:3},{string:6,fret:3});
});
it('removes the note when its fret is clicked, and changes the fret of an occupied string',()=>{
  const {onEdit}=show(build({frets:[[6,3],[5,0]]}));
  fireEvent.click(button(`Remove string 6, fret 3 (${formatPitch(67)})`));
  expect(onEdit).toHaveBeenLastCalledWith({type:'removeNote',target,string:6},{string:6,fret:3});
  fireEvent.click(button(`String 6, fret 5 (${formatPitch(69)})`));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setNote',target,string:6,fret:5},{string:6,fret:5});
  expect(onEdit).toHaveBeenCalledTimes(2);
});
it('shows the beat from the score and numbers frets relative to the capo',()=>{
  const {container,onEdit}=show(build({frets:[[6,3]],capo:2}));
  expect(container.querySelectorAll('[data-note-id]')).toHaveLength(1);expect(container.querySelector('[data-string="6"][data-fret="3"]')).toBeInTheDocument();
  // Fret 3 under a capo on 2 sounds a fifth fret.
  fireEvent.click(button(`Remove string 6, fret 3 (${formatPitch(69)})`));
  expect(onEdit).toHaveBeenCalledWith({type:'removeNote',target,string:6},{string:6,fret:3});
  fireEvent.click(button(`String 6, fret 4 (${formatPitch(70)})`));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setNote',target,string:6,fret:4},{string:6,fret:4});
});
it('places the targets inside the mirrored neck for left-handed players and keeps arrows visual',()=>{
  const {container,onEdit}=show(build());
  fireEvent.click(screen.getByRole('checkbox',{name:'Left-handed'}));
  const mirror=container.querySelector('[data-handedness="left"]')!;
  expect(mirror.querySelectorAll('[data-entry-string][data-entry-fret]')).toHaveLength(6*25);
  const fret=(string:number,n:number)=>mirror.querySelector<SVGElement>(`[data-entry-string="${string}"][data-entry-fret="${n}"]`)!;
  fret(6,5).focus();fireEvent.keyDown(fret(6,5),{key:'ArrowRight'});expect(document.activeElement).toBe(fret(6,4));
  fireEvent.click(fret(6,2));expect(onEdit).toHaveBeenCalledWith({type:'setNote',target,string:6,fret:2},{string:6,fret:2});
});
it('extends the targets to a note beyond fret 24',()=>{
  const {container}=show(build({frets:[[1,27]]}));expect(container.querySelector('[data-entry-string="1"][data-entry-fret="27"]')).toBeInTheDocument();
});

it('adds and removes pitched notes by written pitch, undoing the staff transposition',()=>{
  // A staff written two semitones above what sounds: the key that sounds C4 writes D4.
  const {onEdit}=show(build({tuning:[],program:0,pitches:[62],transposition:2}));
  expect(screen.getByRole('group',{name:'Keyboard'})).toBeInTheDocument();
  fireEvent.click(button(`Remove ${formatPitch(60)}`));
  expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
  fireEvent.click(button(formatPitch(64)));
  expect(onEdit).toHaveBeenLastCalledWith({type:'addPitchedNote',target,pitch:66},{note:{pitch:66}});
  expect(onEdit).toHaveBeenCalledTimes(2);
});
it('offers two octaves around middle C on an empty beat',()=>{
  const {container}=show(build({tuning:[],program:0,empty:true,pitches:[]}));
  for(const key of [48,60,72])expect(container.querySelector(`[data-key="${key}"]`)).toBeInTheDocument();
});
it('enters a keyboard key on a fretted staff at the lowest fret of a free string and removes it again',()=>{
  const {onEdit}=show(build({frets:[[1,0]]}));keysMode();
  // E3 is fret 12 on the occupied low string, fret 7 on string 2 and fret 2 on string 3.
  fireEvent.click(button(formatPitch(52)));
  expect(onEdit).toHaveBeenLastCalledWith({type:'setNote',target,string:3,fret:2},{});
  fireEvent.click(button(`Remove ${formatPitch(40)}`));
  expect(onEdit).toHaveBeenLastCalledWith({type:'removeNote',target,string:1},{});
});
it('disables a key no free string can play, with the reason as its name',()=>{
  const {onEdit}=show(build({frets:[[1,0]]}));keysMode();
  const key=button(`No free string can play ${formatPitch(37)}`);expect(key).toHaveAttribute('aria-disabled','true');
  fireEvent.click(key);expect(onEdit).not.toHaveBeenCalled();
  // Only the lowest string reaches E2 and it is taken, so a second E2 is refused too.
  expect(button(`Remove ${formatPitch(40)}`)).not.toHaveAttribute('aria-disabled');
});

it('adds a kit piece with its default articulation from the standard table and removes it again',()=>{
  const {onEdit}=show(build({percussion:true,program:0,articulations:[38]}));
  expect(screen.getByRole('group',{name:'Drum kit'})).toBeInTheDocument();
  fireEvent.click(button('Kick'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:35},{note:{articulation:35}});
  fireEvent.click(button('Hi-hat'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:42},{note:{articulation:42}});
  // The snare is already struck: the click removes that note instead of stacking another.
  fireEvent.click(button('Remove Snare'));expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
  expect(onEdit).toHaveBeenCalledTimes(3);
});
it('enters the plain hit of the standard table, not a variant that shares its output',()=>{
  // The standard ride lists its edge (id 93) before its middle (id 51), and both sound 51.
  const {onEdit}=show(build({percussion:true,program:0}));
  fireEvent.click(button('Ride'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:51},{note:{articulation:51}});
  fireEvent.click(button('Snare'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:38},{note:{articulation:38}});
});
it('prefers the articulation of a custom table when the track defines one for the piece',()=>{
  // Custom ids 0 and 1 sound the kick and the side stick; ids are never read as MIDI keys.
  const {onEdit}=show(build({percussion:true,program:0,custom:[35,37]}));
  fireEvent.click(button('Kick'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:0},{note:{articulation:0}});
  fireEvent.click(button('Snare'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:1},{note:{articulation:1}});
});
it('removes a note on a key outside the kit through its pad',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0,articulations:[56]}));
  const pad=container.querySelector<HTMLElement>('.percussion-pad[data-percussion-key="56"]')!;expect(pad).toHaveAttribute('role','button');
  fireEvent.click(button('Remove Cowbell'));expect(onEdit).toHaveBeenCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
});

it('never removes a pitched or fretted note through a pad of the drum view',()=>{
  const {container,onEdit}=show(build({frets:[[6,0]]}));fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'drums'}});
  const pad=container.querySelector<HTMLElement>('.percussion-pad[data-percussion-key="64"]')!;expect(pad).toHaveAttribute('aria-disabled','true');
  fireEvent.click(pad);expect(onEdit).not.toHaveBeenCalled();
});

it.each([
  ['no beat is selected',{target:null}],['the bar is an empty placeholder',{}],['controls are busy',{busy:true}],
] as const)('disables every target when %s and sends nothing',(label,entry)=>{
  const {container,onEdit}=show(build({empty:label==='the bar is an empty placeholder'}),entry);
  const targets=[...container.querySelectorAll('[data-entry-target]')];expect(targets.length).toBeGreaterThan(0);
  expect(targets.every(item=>item.getAttribute('aria-disabled')==='true')).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent(label==='controls are busy'?/another operation/:'Select a beat in the score to edit it');
  fireEvent.click(targets[0]);fireEvent.keyDown(targets[0],{key:'Enter'});expect(onEdit).not.toHaveBeenCalled();
});
it('disables the keyboard on a percussion staff and the drum kit on a pitched staff',()=>{
  const {container,onEdit,unmount}=show(build({percussion:true,program:0,articulations:[38]}));keysMode();
  expect(screen.getByRole('status')).toHaveTextContent('percussion staff');fireEvent.click(container.querySelector('[data-key="60"]')!);expect(onEdit).not.toHaveBeenCalled();unmount();
  const next=show(build({tuning:[],program:0,pitches:[60]}));fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'drums'}});
  expect(screen.getByRole('status')).toHaveTextContent('drum kit');fireEvent.click(button('Kick'));expect(next.onEdit).not.toHaveBeenCalled();
});

it('renders no targets and keeps the images when not editing',()=>{
  const score=build({frets:[[1,0]]}),{container}=render(<InstrumentView score={score} track={0} staff={0} notes={[]}/>);
  expect(screen.getByRole('img',{name:'Guitar fretboard'})).toBeInTheDocument();expect(container.querySelector('[data-entry-target]')).toBeNull();expect(container.querySelector('.instrument-entry-hint')).toBeNull();
});

it('keeps one tab stop per instrument with arrows moving between targets and Enter or Space entering',()=>{
  const {container,onEdit}=show(build());
  const stops=()=>[...container.querySelectorAll('[data-entry-target]')].filter(item=>item.getAttribute('tabindex')==='0');
  expect(stops()).toHaveLength(1);expect(stops()[0]).toHaveAttribute('data-entry-target','6/0');
  const item=(id:string)=>container.querySelector<SVGElement>(`[data-entry-target="${id}"]`)!;
  item('6/0').focus();fireEvent.keyDown(item('6/0'),{key:'ArrowDown'});
  expect(document.activeElement).toBe(item('5/0'));expect(stops()).toEqual([item('5/0')]);
  fireEvent.keyDown(item('5/0'),{key:'ArrowRight'});expect(document.activeElement).toBe(item('5/1'));
  fireEvent.keyDown(item('5/1'),{key:'Enter'});expect(onEdit).toHaveBeenLastCalledWith({type:'setNote',target,string:5,fret:1},{string:5,fret:1});
  fireEvent.keyDown(item('5/1'),{key:' '});expect(onEdit).toHaveBeenCalledTimes(2);
  // The edges stay put.
  fireEvent.keyDown(item('5/1'),{key:'Home'});expect(document.activeElement).toBe(item('5/0'));
});
it('moves between keys and between drum pieces with the arrow keys',()=>{
  const keys=show(build({tuning:[],program:0,pitches:[60]}));
  const key=(n:number)=>keys.container.querySelector<SVGElement>(`[data-key="${n}"]`)!;
  expect(key(60)).toHaveAttribute('tabindex','0');key(60).focus();fireEvent.keyDown(key(60),{key:'ArrowRight'});expect(document.activeElement).toBe(key(61));
  fireEvent.keyDown(key(61),{key:'Enter'});expect(keys.onEdit).toHaveBeenCalledWith({type:'addPitchedNote',target,pitch:61},{note:{pitch:61}});
  cleanup();
  const drums=show(build({percussion:true,program:0,articulations:[56]}));
  const piece=(id:string)=>drums.container.querySelector<SVGElement>(`[data-drum="${id}"]`)!;
  expect(drums.container.querySelectorAll('[data-drum][tabindex="0"]')).toHaveLength(1);
  piece('splash').focus();fireEvent.keyDown(piece('splash'),{key:'ArrowRight'});expect(document.activeElement).toBe(piece('hi-hat'));
});
