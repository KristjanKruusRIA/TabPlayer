// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {SoundPanel,soundPreset} from './SoundPanel';
import {chainOrder,completeSound,defaultEffects,soundProblem} from '../document-settings';
import {readSoundLibrary,saveSoundPreset} from './sound-library';
import type {EffectBlock,TrackSound} from '../edit-types';
afterEach(()=>{cleanup();localStorage.clear();});
const bands=['31','63','125','250','500','1k','2k','4k','8k','16k'];

it('defaults to a flat graphic EQ, switched off, as the native player does',()=>{
  expect(defaultEffects().graphicEq).toEqual({enabled:false,gainsDb:[0,0,0,0,0,0,0,0,0,0],levelDb:0});
});

it('gives sounds saved before the graphic EQ a flat one',()=>{
  const older=soundPreset('lead') as unknown as {effects:Record<string,unknown>};
  delete older.effects.graphicEq;
  expect(soundProblem(older as unknown as TrackSound)).toBeNull();
  expect(completeSound(older as unknown as TrackSound).effects.graphicEq).toEqual(defaultEffects().graphicEq);
});

it('lists the graphic EQ after the EQ with a field for each band and a level',()=>{
  const onEdit=vi.fn();render(<SoundPanel trackId="base/0" sound={soundPreset('gm')} onEdit={onEdit}/>);
  const names=[...document.querySelectorAll('.sound-block-name')].map(node=>node.textContent);
  expect(names.slice(names.indexOf('EQ'),names.indexOf('EQ')+2)).toEqual(['EQ','Graphic EQ']);
  const last=()=>onEdit.mock.calls.at(-1)?.[0].sound.effects.graphicEq;
  fireEvent.click(screen.getByLabelText('Enable graphicEq'));expect(last().enabled).toBe(true);
  for(const [index,band] of bands.entries()){
    const input=screen.getByLabelText(`Graphic EQ ${band} Hz (dB)`);
    expect(input).toHaveAttribute('min','-12');expect(input).toHaveAttribute('max','12');
    const gain=index%2?index+1:-(index+1);fireEvent.change(input,{target:{value:String(gain)}});
    expect(last().gainsDb[index]).toBe(gain);
    expect(last().gainsDb.filter((_:number,other:number)=>other!==index)).toEqual(Array(9).fill(0));
  }
  fireEvent.change(screen.getByLabelText('graphicEq Level (dB)'),{target:{value:'-3'}});expect(last().levelDb).toBe(-3);
  // Values out of range are not recorded.
  const calls=onEdit.mock.calls.length;
  fireEvent.change(screen.getByLabelText('Graphic EQ 1k Hz (dB)'),{target:{value:'13'}});
  expect(onEdit.mock.calls.length).toBe(calls);
});

it('flattens every band at once',()=>{
  const onEdit=vi.fn(),sound=soundPreset('gm');sound.effects.graphicEq={enabled:true,gainsDb:[1,2,3,4,5,6,7,8,9,10],levelDb:2};
  render(<SoundPanel trackId="base/0" sound={sound} onEdit={onEdit}/>);
  fireEvent.click(screen.getByRole('button',{name:'Flatten graphic EQ'}));
  expect(onEdit.mock.calls.at(-1)?.[0].sound.effects.graphicEq).toEqual({enabled:true,gainsDb:Array(10).fill(0),levelDb:2});
});

it('refuses graphic EQ settings the native player would reject',()=>{
  const with_=(patch:Record<string,unknown>)=>{const sound=soundPreset('gm');Object.assign(sound.effects.graphicEq,patch);return soundProblem(sound);};
  expect(with_({gainsDb:[12,-12,0,0,0,0,0,0,0,0],levelDb:-12})).toBeNull();
  expect(with_({gainsDb:[12.5,0,0,0,0,0,0,0,0,0]})).toBe('Invalid effect parameter.');
  expect(with_({gainsDb:Array(9).fill(0)})).toBe('Invalid effect parameter.');
  expect(with_({gainsDb:[Number.NaN,0,0,0,0,0,0,0,0,0]})).toBe('Invalid effect parameter.');
  expect(with_({gainsDb:'flat'})).toBe('Invalid effect parameter.');
  expect(with_({levelDb:13})).toBe('Invalid effect parameter.');
});

it('places the graphic EQ after the EQ in an order saved before it',()=>{
  const older=['microphone','gate','compressor','wah','octaver','pitch','amp','cabinet','eq','drive','vibrato','phaser','flanger','chorus','tremolo','delay','reverb'] as EffectBlock[];
  const sound=soundPreset('gm');sound.effects.order=older;
  expect(soundProblem(sound)).toBeNull();
  expect(chainOrder(sound.effects).slice(7,11)).toEqual(['cabinet','eq','graphicEq','drive']);
  sound.effects.order=[...older.slice(1),'graphicEq'] as EffectBlock[];
  expect(soundProblem(sound)).toBe('Invalid effect order.');
  sound.effects.order=[...older,'graphicEq','graphicEq'] as EffectBlock[];
  expect(soundProblem(sound)).toBe('Invalid effect order.');
});

it('keeps the graphic EQ through a saved sound',()=>{
  const sound=soundPreset('lead');sound.effects.graphicEq={enabled:true,gainsDb:[3,0,0,0,-6,0,0,0,2,0],levelDb:-1.5};
  expect(saveSoundPreset('Scooped',sound,localStorage).ok).toBe(true);
  expect(readSoundLibrary(localStorage).find(entry=>entry.name==='Scooped')?.sound.effects.graphicEq).toEqual(sound.effects.graphicEq);
});
