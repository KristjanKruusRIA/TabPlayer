import type { BeatTarget } from '../project';

export interface PerformedBeat {target:BeatTarget;occurrence:number;startTick:number;endTick:number;leadInTick:number}
export interface PlaybackSpan {startTick:number;endTick:number}
export interface CursorPlaybackChoice {generation:number;occurrenceIndex:number;startTick:number}
export interface PassagePlaybackChoice {generation:number;startOccurrence:number;endOccurrence:number;startTick:number;endTick:number}
