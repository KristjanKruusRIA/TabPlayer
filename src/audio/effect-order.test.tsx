// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {chainOrder,completeSound,defaultEffects,effectBlocks,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {EffectBlock,TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});
const native=['microphone','gate','compressor','wah','octaver','pitch','drive','amp','cabinet','eq','graphicEq','vibrato','phaser','flanger','chorus','tremolo','delay','reverb'];
/** The default order with `block` moved to just after `after`. */
const moved=(block:string,after:string)=>{const names=native.filter(name=>name!==block);names.splice(names.indexOf(after)+1,0,block);return names as EffectBlock[];};
const shownOrder=()=>[...document.querySelectorAll('.sound-block-name')].map(node=>node.textContent);

it('keeps the native default order and writes none for it',()=>{
  expect(effectBlocks).toEqual(native);
  expect(defaultEffects()).not.toHaveProperty('order');
  expect(chainOrder(defaultEffects())).toEqual(native);
  const sound=soundPreset('lead');sound.effects.order=moved('delay','pitch');
  expect(chainOrder(completeSound(sound).effects)).toEqual(moved('delay','pitch'));
  expect(chainOrder({...defaultEffects(),order:[]})).toEqual(native);
});

it('accepts an order only when it names every block once, as the native player does',()=>{
  const with_=(order:unknown)=>{const sound=soundPreset('gm') as unknown as {effects:Record<string,unknown>};sound.effects.order=order;return soundProblem(sound as unknown as TrackSound);};
  expect(with_(native)).toBeNull();
  expect(with_([])).toBeNull();
  expect(with_(moved('drive','delay'))).toBeNull();
  expect(with_([...native].reverse())).toBeNull();
  expect(with_(native.slice(1))).toBe('Invalid effect order.');
  expect(with_([...native,'gate'])).toBe('Invalid effect order.');
  expect(with_(native.map(name=>name==='gate'?'drive':name))).toBe('Invalid effect order.');
  expect(with_(native.map(name=>name==='eq'?'talkbox':name))).toBe('Invalid effect order.');
  expect(with_('drive,delay')).toBe('Invalid effect order.');
  expect(with_(null)).toBe('Invalid effect order.');
});

it('shows the blocks in the sound’s order and moves them one place at a time',()=>{
  const onEdit=vi.fn(),sound=soundPreset('gm');
  const {rerender}=render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  expect(screen.getByText('Signal chain')).toBeInTheDocument();
  expect(shownOrder()).toEqual(['Microphone','Gate','Compressor','Wah','Octaver','Pitch shift','Drive','Amp','Cabinet','EQ','Graphic EQ','Vibrato','Phaser','Flanger','Chorus','Tremolo','Delay','Reverb']);
  expect(screen.getByRole('button',{name:'Move Microphone earlier'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Move Reverb later'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Move Drive later'}));
  const edit=onEdit.mock.calls.at(-1)?.[0];
  expect(edit.type).toBe('setTrackSound');
  expect(edit.sound.effects.order).toEqual(moved('drive','amp'));
  expect(edit.sound.effects.drive).toEqual(sound.effects.drive);
  rerender(<SoundPanel trackId="base/0" sound={edit.sound} onEdit={onEdit}/>);
  expect(shownOrder().slice(5,9)).toEqual(['Pitch shift','Amp','Drive','Cabinet']);
  // Moving it back is the default order, which is written as no order at all.
  fireEvent.click(screen.getByRole('button',{name:'Move Drive earlier'}));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects).not.toHaveProperty('order');
});

it('keeps a block’s settings and the order apart when a pedal is pasted',()=>{
  const onEdit=vi.fn(),sound=soundPreset('lead');sound.effects.order=moved('reverb','gate');
  render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  expect(shownOrder().slice(0,3)).toEqual(['Microphone','Gate','Reverb']);
  fireEvent.click(screen.getByRole('button',{name:'Copy pedal: Delay'}));
  fireEvent.click(screen.getByRole('button',{name:'Paste pedal: Delay'}));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.order).toEqual(moved('reverb','gate'));
});

it('keeps the order through a saved sound and a copied one',()=>{
  const sound=soundPreset('crunch');sound.effects.order=moved('drive','delay');
  expect(saveSoundPreset('Late drive',sound,localStorage).ok).toBe(true);
  expect(readSoundLibrary(localStorage).find(entry=>entry.name==='Late drive')?.sound.effects.order).toEqual(moved('drive','delay'));
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  fireEvent.click(screen.getByRole('button',{name:'Copy sound'}));
  fireEvent.click(screen.getByRole('button',{name:'Paste sound'}));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.order).toEqual(moved('drive','delay'));
});

it('keeps keyboard focus on the moved block and says where it went',async()=>{
  const onEdit=vi.fn(),sound=soundPreset('gm');
  const {rerender}=render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  const later=screen.getByRole('button',{name:'Move Drive later'});later.focus();fireEvent.click(later);
  await screen.findByText('Drive is now 8 of 18 in the chain.');
  rerender(<SoundPanel trackId="base/0" sound={onEdit.mock.calls.at(-1)?.[0].sound} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Move Drive later'})).toHaveFocus();
  // At an end of the chain the pressed button is disabled, so focus goes to the other one.
  rerender(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  const delayLater=screen.getByRole('button',{name:'Move Delay later'});delayLater.focus();fireEvent.click(delayLater);
  rerender(<SoundPanel trackId="base/0" sound={onEdit.mock.calls.at(-1)?.[0].sound} onEdit={onEdit}/>);
  expect(screen.getByRole('button',{name:'Move Delay later'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Move Delay earlier'})).toHaveFocus();
});

it('returns to the default order when a factory preset is chosen',()=>{
  const onEdit=vi.fn(),sound=soundPreset('lead');sound.effects.order=moved('drive','delay');
  render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  fireEvent.change(screen.getByLabelText('Sound preset'),{target:{value:'crunch'}});
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects).not.toHaveProperty('order');
});
