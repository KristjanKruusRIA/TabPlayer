import {expect,it} from 'vitest';
import {readLineInPreferences,soundForChoice} from './line-in-preferences';
import {earlierFactorySound} from './factory-sounds';

// A factory choice is followed by name: the Line-In plays the sound as it is defined now (`settingsOf` in LineInPanel), and the
// sound stored beside it only stands in once its source is gone. So a Line-In that chose Metal rhythm plays the retuned sound
// (THE-217), and the stored copy of the old one is not what is played.
it('plays a factory choice as the factory sound is defined now, whatever sound is stored beside it',()=>{
  const old=earlierFactorySound('metal-rhythm')!;
  const storage={getItem:()=>JSON.stringify({choice:'factory:metal-rhythm',sound:old,level:.8,inputId:''}),setItem:()=>{}};
  const read=readLineInPreferences(storage);
  expect(read.choice).toBe('factory:metal-rhythm');
  expect(read.sound.effects.amp.drive).toBe(.55);
  const played=soundForChoice(read.choice)!;
  expect(played.effects.amp.lowEndOct).toBe(1);expect(played.effects.amp.drive).toBe(.2);
});
