export type PracticeTempo=
  |{kind:'relative';ratio:number}
  |{kind:'fixed';bpm:number}
  |{kind:'progressive';start:number;end:number;step:number;repetitions:number};
export interface MetronomeSettings {enabled:boolean;volume:number;visual:boolean}
export interface CountInSettings {bars:number;betweenLoops:boolean}
export interface PracticeSettings {tempo:PracticeTempo;metronome:MetronomeSettings;countIn:CountInSettings}
export interface PracticePulse {serial:number;beat:number;beatsPerBar:number;accent:boolean;counting:boolean}
export interface PracticeStatus {
  settings:PracticeSettings;phase:'idle'|'countIn'|'playing'|'paused'|'ended';countInRemaining:number;completedPasses:number;
  effectiveRatio:number;currentBpm:number;pulse:PracticePulse|null;
}
export interface PracticeLoop {startTick:number;endTick:number}
export const DEFAULT_PRACTICE:PracticeSettings={tempo:{kind:'relative',ratio:1},metronome:{enabled:false,volume:.4,visual:false},countIn:{bars:0,betweenLoops:false}};
