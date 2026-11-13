export type PracticeTempo=
  |{kind:'relative';ratio:number}
  |{kind:'fixed';bpm:number}
  |{kind:'progressive';start:number;end:number;step:number;repetitions:number};
/** The metronome's timbre; the native renderer synthesises each one. */
export type ClickSound='beep'|'woodblock'|'cowbell'|'stick';
export const CLICK_SOUNDS:readonly ClickSound[]=['beep','woodblock','cowbell','stick'];
/** `sound` is absent in settings written before it could be chosen, and then means the beep. */
export interface MetronomeSettings {enabled:boolean;volume:number;visual:boolean;sound?:ClickSound}
export interface CountInSettings {bars:number;betweenLoops:boolean}
/** `tonality` is the playback-only key shift in whole semitones (-12 to 12); absent means the original key. Session-only, never saved with the score. */
export interface PracticeSettings {tempo:PracticeTempo;metronome:MetronomeSettings;countIn:CountInSettings;tonality?:number}
export interface PracticePulse {serial:number;beat:number;beatsPerBar:number;accent:boolean;counting:boolean}
export interface PracticeStatus {
  settings:PracticeSettings;phase:'idle'|'countIn'|'playing'|'paused'|'ended';countInRemaining:number;completedPasses:number;
  effectiveRatio:number;currentBpm:number;pulse:PracticePulse|null;
}
export interface PracticeLoop {startTick:number;endTick:number}
export const DEFAULT_PRACTICE:PracticeSettings={tempo:{kind:'relative',ratio:1},metronome:{enabled:false,volume:.4,visual:false,sound:'beep'},countIn:{bars:0,betweenLoops:false}};
export const tonalityOf=(settings:PracticeSettings):number=>settings.tonality??0;
export const clickSoundOf=(metronome:MetronomeSettings):ClickSound=>metronome.sound??'beep';
