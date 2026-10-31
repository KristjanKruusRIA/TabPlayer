// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { standardPercussionCatalog } from '../editor/percussion-catalog';
import { defaultArticulation, drumPieces, instrumentHits, ownerOf, percussionInstruments } from './drum-kit';
import { hasPercussionArt } from './percussion-art';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { formatPitch } from '../tuning';
import { InstrumentView } from './InstrumentView';

afterEach(()=>{cleanup();localStorage.clear();});
const guitar=[64,59,55,50,45,40], target={track:0,staff:0,bar:0,voice:0,beat:0};
interface Spec { tuning?:number[]; program?:number; percussion?:boolean; frets?:[number,number][]; pitches?:number[]; articulations?:number[]; capo?:number; transposition?:number; empty?:boolean; custom?:number[]; table?:model.InstrumentArticulation[] }
/** One beat holding the given notes: string/fret pairs, written pitches or percussion articulation ids. */
function build({tuning=guitar,program=25,percussion=false,frets=[],pitches=[],articulations=[],capo=0,transposition=0,empty=false,custom,table}:Spec={}) {
  const score=new model.Score(),track=new model.Track(),staff=new model.Staff();track.name=percussion?'Drums':'Track';track.playbackInfo.program=program;
  staff.stringTuning.tunings=[...tuning];staff.isPercussion=percussion;staff.capo=capo;staff.transpositionPitch=transposition;
  if(custom)track.percussionArticulations=custom.map(out=>new model.InstrumentArticulation('Custom',0,out,model.MusicFontSymbol.NoteheadXBlack,model.MusicFontSymbol.NoteheadHalf,model.MusicFontSymbol.NoteheadWhole));
  if(table)track.percussionArticulations=table;
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
it('removes a percussion note through its instrument',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0,articulations:[56]}));
  const item=container.querySelector<HTMLElement>('[data-percussion="cowbell"]')!;expect(item).toHaveAttribute('role','button');
  fireEvent.click(button('Remove Cowbell'));expect(onEdit).toHaveBeenCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
});

it('never removes a pitched or fretted note through the percussion of the drum view',()=>{
  const {container,onEdit}=show(build({frets:[[6,0]]}));fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'drums'}});
  const pad=container.querySelector<HTMLElement>('[data-percussion="conga-low"]')!;expect(pad).toHaveAttribute('aria-disabled','true');
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

it('has hardware for every standard articulation, each on exactly one instrument',()=>{
  const track=new model.Track(),owners=[...drumPieces,...percussionInstruments].flatMap(item=>instrumentHits(track,item).map(hit=>hit.id));
  expect(new Set(owners).size).toBe(owners.length);expect(new Set(owners)).toEqual(new Set(standardPercussionCatalog.map(entry=>entry.id)));
  for(const item of percussionInstruments)expect(hasPercussionArt(item.id)).toBe(true);
  const sounding=[...drumPieces,...percussionInstruments].flatMap(item=>[...item.keys]);expect(new Set(sounding).size).toBe(sounding.length);
});

it('enters any hit of the chosen piece, and removes the hit the beat holds',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0,articulations:[91]}));
  const snare=container.querySelector<SVGElement>('[data-drum="snare"]')!;fireEvent.focus(snare);
  const hits=screen.getByRole('group',{name:'Snare hits'}),press=(name:string)=>fireEvent.click(within(hits).getByRole('button',{name}));
  expect(within(hits).getByRole('button',{name:'rim shot'})).toHaveAttribute('aria-pressed','true');
  press('side stick');expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:37},{note:{articulation:37}});
  press('rim shot');expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
  expect(button('Remove Snare')).toBe(snare);
});

it('refuses a named hit while busy and keeps it focusable',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0,articulations:[91]}),{busy:true});
  fireEvent.focus(container.querySelector<SVGElement>('[data-drum="ride"]')!);
  const bell=within(screen.getByRole('group',{name:'Ride hits'})).getByRole('button',{name:'bell'});
  expect(bell).not.toHaveAttribute('disabled');expect(bell).toHaveAttribute('aria-disabled','true');fireEvent.click(bell);expect(onEdit).not.toHaveBeenCalled();
});

it('enters an instrument that shares its pitch with another as itself',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0}));
  fireEvent.click(container.querySelector('[data-percussion="cowbell-low"]')!);expect(onEdit).toHaveBeenCalledWith({type:'addPercussionNote',target,articulation:99},{note:{articulation:99}});
});

/** A custom table shaped like the ones Guitar Pro 7 files carry: 60 entries, each named by the element it belongs to. Standard ids 0-59 are hidden by it. */
function gpTable() {
  const {NoteheadBlack:black,NoteheadXBlack:cross,PictEdgeOfCymbal:edge,None:none}=model.MusicFontSymbol;
  const entry=(element:string,output:number,head=black,technique=none)=>new model.InstrumentArticulation(element,0,output,head,head,head,technique,1);
  const table=Array.from({length:60},()=>entry('Unused',20));
  Object.assign(table,{3:entry('Crash High',49,cross),30:entry('Reverse Cymbal',49,cross),37:entry('Metronome',37,cross),38:entry('Snare',38),39:entry('Snare',37,cross),49:entry('Piatti',49),51:entry('Ride',51,cross),53:entry('Bell Tree',53),58:entry('Ride Cymbal 2',59,cross),59:entry('Ride Cymbal 2',59,cross,edge)});
  return table;
}
const gp=(articulations:number[]=[])=>build({percussion:true,program:0,table:gpTable(),articulations});
const everyInstrument=[...drumPieces,...percussionInstruments], instrument=(id:string)=>everyInstrument.find(item=>item.id===id)!;

it('attaches the hits of a Guitar Pro style table by the element they name, not by their pitch',()=>{
  const track=new model.Track();track.percussionArticulations=gpTable();
  const ids=(id:string)=>instrumentHits(track,instrument(id)).filter(hit=>hit.id<60).map(hit=>hit.id);
  // Pitch 49 is a crash, a piatti and a reverse cymbal; each gets only its own.
  expect(ids('crash')).toEqual([3]);expect(ids('piatti')).toEqual([49]);expect(ids('reverse')).toEqual([30]);
  // 53 is the ride's bell pitch and a bell tree's; 37 and 38 are a snare's and a metronome's.
  expect(ids('ride')).toEqual([51]);expect(ids('bell-tree')).toEqual([53]);expect(ids('metronome')).toEqual([37]);expect(ids('snare')).toEqual([38,39]);
  const {onEdit}=show(gp());
  const enters=(name:string,articulation:number)=>{fireEvent.click(button(name));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation},{note:{articulation}});};
  enters('Crash',3);enters('Piatti',49);enters('Reverse',30);enters('Ride',51);enters('Bell tree',53);enters('Metronome',37);enters('Snare',38);
  // The second ride enters its middle, not the edge that comes after it.
  enters('Ride 2',58);
});
it('lights and removes by the element of a custom hit as well, so a shared pitch holds only its owner',()=>{
  const {container,onEdit}=show(gp([49]));
  const active=(selector:string)=>container.querySelector(selector)!.getAttribute('data-active');
  expect(active('[data-percussion="piatti"]')).toBe('true');expect(active('[data-drum="crash"]')).toBe('false');expect(active('[data-drum="reverse"]')).toBe('false');
  fireEvent.click(button('Remove Piatti'));expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
  // The crash does not see the piatti as its own hit: it enters instead of removing.
  fireEvent.click(button('Crash'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:3},{note:{articulation:3}});
});
it('has no hit for a piece the custom table does not name',()=>{
  const table=gpTable();table[30]=new model.InstrumentArticulation('Unused',0,20);
  const {onEdit}=show(build({percussion:true,program:0,table}));
  const reverse=button('Reverse (no articulation on this track)');expect(reverse).toHaveAttribute('aria-disabled','true');fireEvent.click(reverse);expect(onEdit).not.toHaveBeenCalled();
});

it('enters the plain hit of every piece with several hits by intent, not by key order',()=>{
  const track=new model.Track(),several=everyInstrument.filter(item=>instrumentHits(track,item).length>1);
  // Ride 2 enters its middle like the ride, the triangle its open hit and the cuica its open sound, never a mute.
  const plain:Record<string,number>={snare:38,'hi-hat':42,ride:51,'ride-2':126,china:52,crash:49,'crash-2':57,splash:55,'conga-high':63,'conga-low':64,'bongo-high':60,'bongo-low':61,cowbell:56,'cowbell-low':99,'cowbell-high':102,tambourine:54,triangle:81,cuica:79,surdo:86,guiro:73,cabasa:69,shaker:82,'maraca-left':70,'maraca-right':119,'bell-tree':84,piatti:115,golpe:124,metronome:33};
  expect(several.map(item=>item.id).sort()).toEqual(Object.keys(plain).sort());
  for(const item of several)expect([item.id,defaultArticulation(track,item)]).toEqual([item.id,plain[item.id]]);
  for(const item of everyInstrument)expect(instrumentHits(track,item).map(hit=>hit.id)).toContain(item.hit);
});
it('presses the triangle, the cuica and the second ride to their open, open and middle hits',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0}));
  for(const [id,articulation] of [['triangle',81],['cuica',79]] as const){fireEvent.click(container.querySelector(`[data-percussion="${id}"]`)!);expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation},{note:{articulation}});}
  fireEvent.click(button('Ride 2'));expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:126},{note:{articulation:126}});
});

it('maps each standard articulation to the owner its element names and keeps pitch only as a fallback',()=>{
  const track=new model.Track();
  // Playback knows only a pitch, so it lights the instrument that lists it. Every standard articulation lights its owner, except these:
  // the pitch is another instrument's (or nobody's), and during playback they light that one instead. Edit mode is exact.
  const lightedBy=(key:number)=>everyInstrument.find(item=>item.keys.includes(key))?.id;
  const wrong=Object.fromEntries(standardPercussionCatalog.flatMap(entry=>{const owner=ownerOf(track,entry.id)!.id,lit=lightedBy(entry.outputMidiNumber);return lit===owner?[]:[[entry.id,`${owner} -> ${lit}`]];}));
  expect(wrong).toEqual({
    30:'reverse -> crash',31:'snare -> electric-snare',33:'metronome -> snare',34:'metronome -> snare',83:'jingle-bell -> ride',84:'bell-tree -> ride',99:'cowbell-low -> cowbell',100:'cowbell-low -> cowbell',
    102:'cowbell-high -> cowbell',103:'cowbell-high -> cowbell',114:'grancassa -> high-floor-tom',115:'piatti -> crash',116:'piatti -> crash',119:'maraca-right -> maraca-left',120:'maraca-right -> maraca-left',
    123:'bell-tree -> ride',124:'golpe -> conga-high',125:'golpe -> conga-high',
  });
  expect(ownerOf(track,31)?.id).toBe('snare');expect(ownerOf(track,114)?.id).toBe('grancassa');expect(ownerOf(track,33)?.id).toBe('metronome');
  // An element nobody knows is placed by its pitch.
  const custom=new model.Track();custom.percussionArticulations=[new model.InstrumentArticulation('Custom',0,36)];
  expect(ownerOf(custom,0)?.id).toBe('kick-2');
});
it('names a hit cleanly, never by a bare id or the tail of its label',()=>{
  const track=new model.Track(),names=(id:string)=>instrumentHits(track,instrument(id)).map(hit=>hit.name);
  expect(names('snare')).toEqual(['hit','side stick','rim shot','side stick 2']);expect(names('ride-2')).toEqual(['edge 2','middle 2','bell 2','choke 2']);
  expect(names('hi-hat')).toEqual(['closed','half','open','pedal']);
  const custom=new model.Track();custom.percussionArticulations=gpTable();
  expect(instrumentHits(custom,instrument('snare')).filter(hit=>hit.id<60).map(hit=>hit.name)).toEqual(['hit','side stick']);
  custom.percussionArticulations=[7,8,9].map(()=>new model.InstrumentArticulation('Snare',0,38,model.MusicFontSymbol.NoteheadSlashedBlack2));
  expect(instrumentHits(custom,instrument('snare')).filter(hit=>hit.id<3).map(hit=>hit.name)).toEqual(['hit','hit 2','hit 3']);
});

it('lights what the beat holds by articulation in edit mode and names the same hardware in the list',()=>{
  // Grancassa (id 114) sounds pitch 43, which is also the high floor tom; the two are different hardware.
  const {container}=show(build({percussion:true,program:0,articulations:[114]}));
  const active=(selector:string)=>container.querySelector(selector)!.getAttribute('data-active');
  expect(active('[data-percussion="grancassa"]')).toBe('true');expect(active('[data-drum="high-floor-tom"]')).toBe('false');
  const list=screen.getByRole('group',{name:'Sounding notes'});expect(list).toHaveTextContent('Grancassa');expect(list).not.toHaveTextContent('High floor');
  expect(button('Remove Grancassa')).toBeInTheDocument();expect(button('High floor')).toBeInTheDocument();
  expect(container.querySelector('.instrument-percussion-pads')).toBeNull();
});
it('lights the side stick 2 on the snare, the metronome on itself and the piatti on itself',()=>{
  for(const [articulation,lit,unlit] of [[31,'snare','electric-snare'],[33,'metronome','snare'],[115,'piatti','crash']] as const){
    const {container}=show(build({percussion:true,program:0,articulations:[articulation]}));
    const state=(id:string)=>(container.querySelector(`[data-drum="${id}"]`)??container.querySelector(`[data-percussion="${id}"]`))!.getAttribute('data-active');
    expect([lit,state(lit)]).toEqual([lit,'true']);expect([unlit,state(unlit)]).toEqual([unlit,'false']);cleanup();
  }
});
it('removes only the hit of the pressed instrument when others share its pitch',()=>{
  const {container,onEdit}=show(build({percussion:true,program:0,articulations:[56]}));
  // The medium cowbell holds pitch 56; the low and high cowbells sound it too but are not held.
  fireEvent.click(container.querySelector('[data-percussion="cowbell-low"]')!);expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:99},{note:{articulation:99}});
  fireEvent.click(container.querySelector('[data-percussion="cowbell-high"]')!);expect(onEdit).toHaveBeenLastCalledWith({type:'addPercussionNote',target,articulation:102},{note:{articulation:102}});
  fireEvent.click(button('Remove Cowbell'));expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:0},{note:null});
});

it('shows the hits only while their piece or the row has focus',()=>{
  const {container}=show(build({percussion:true,program:0}));
  const piece=(id:string)=>container.querySelector<SVGElement>(`[data-drum="${id}"]`)!,hits=(name:string)=>screen.queryByRole('group',{name});
  // Nothing has focus on mount, and the roving tab stop is not focus.
  expect(hits('Splash hits')).toBeNull();expect(container.querySelector('.drum-hits')).toBeNull();
  act(()=>piece('snare').focus());expect(hits('Snare hits')).toBeInTheDocument();
  // Moving from the piece to its row keeps the row, and the row keeps the focus.
  const rim=within(hits('Snare hits')!).getByRole('button',{name:'rim shot'});act(()=>rim.focus());
  expect(document.activeElement).toBe(rim);expect(hits('Snare hits')).toBeInTheDocument();
  act(()=>piece('kick').focus());expect(container.querySelector('.drum-hits')).toBeNull();
  act(()=>piece('ride').focus());expect(hits('Ride hits')).toBeInTheDocument();
  act(()=>piece('ride').blur());expect(container.querySelector('.drum-hits')).toBeNull();
});
it('refuses the named hits of a pitched staff in the drum view as it refuses its pieces',()=>{
  const {container,onEdit}=show(build({tuning:[],program:0,pitches:[60]}));fireEvent.change(screen.getByLabelText('Instrument view mode'),{target:{value:'drums'}});
  act(()=>container.querySelector<SVGElement>('[data-drum="snare"]')!.focus());
  const side=within(screen.getByRole('group',{name:'Snare hits'})).getByRole('button',{name:'side stick'});
  expect(side).toHaveAttribute('aria-disabled','true');expect(side).not.toHaveAttribute('disabled');fireEvent.click(side);expect(onEdit).not.toHaveBeenCalled();
});

it('keeps the row when the window loses focus while the row has it',()=>{
  const {container}=show(build({percussion:true,program:0}));
  act(()=>container.querySelector<SVGElement>('[data-drum="snare"]')!.focus());
  const rim=within(screen.getByRole('group',{name:'Snare hits'})).getByRole('button',{name:'rim shot'});act(()=>rim.focus());
  // Alt-Tab fires a blur with no related target while the element stays the active one.
  fireEvent.blur(rim);expect(screen.getByRole('group',{name:'Snare hits'})).toBeInTheDocument();expect(document.activeElement).toBe(rim);
});
it('reserves the row\'s place so nothing moves when it appears',()=>{
  const {container}=show(build({percussion:true,program:0}));
  const slot=container.querySelector('.drum-hits-slot')!;expect(slot).toBeInTheDocument();expect(slot.children).toHaveLength(0);
  act(()=>container.querySelector<SVGElement>('[data-drum="snare"]')!.focus());
  expect(container.querySelector('.drum-hits-slot')).toBe(slot);expect(slot.children).toHaveLength(1);
});
it('removes through a pad only a note nobody owns, not a hit that shares its pitch',()=>{
  const entry=(element:string)=>new model.InstrumentArticulation(element,0,20,model.MusicFontSymbol.NoteheadBlack);
  const {container,onEdit}=show(build({percussion:true,program:0,table:[entry('Snare'),entry('Foo')],articulations:[0,1]}));
  fireEvent.click(container.querySelector('[data-percussion-key="20"]')!);
  expect(onEdit).toHaveBeenLastCalledWith({type:'removeNoteByIndex',target,noteIndex:1},{note:null});
});
it('hides a standard hit that twins one of the custom table',()=>{
  const track=new model.Track();track.percussionArticulations=[new model.InstrumentArticulation('Snare',0,38,model.MusicFontSymbol.NoteheadBlack)];
  const hits=instrumentHits(track,instrument('snare'));
  expect(hits.map(hit=>hit.id)).not.toContain(38);expect(hits[0]).toMatchObject({id:0,name:'hit'});expect(hits.map(hit=>hit.name)).toEqual(['hit','side stick','rim shot','side stick 2']);
});
