import { invoke } from '@tauri-apps/api/core';
import type { ScoreFilesDroppedEvent } from '../library/types';

/**
 * The next waiting launch file as a drop of its own the Library can open (null when none waits), or `waiting` when
 * native work such as an export must finish first; it is then kept. `dropped` counts files refused since the last take
 * because too many were waiting.
 */
export interface LaunchTake {event:ScoreFilesDroppedEvent|null;waiting:boolean;dropped:number}
/**
 * Takes the next score file the operating system asked TabPlayer to open (a double-clicked file, or a second launch).
 * Native code keeps them until this is called, so the caller asks only once the workspace and Library can open them.
 */
export function takeLaunchFiles():Promise<LaunchTake>{return invoke('launch_files_take');}
/**
 * Settles a taken file once its open has finished, whatever the outcome. A file the intake never received waits again
 * natively and this returns true; with `keep` false it is let go instead.
 */
export function settleLaunchFiles(dropToken:string,keep=true):Promise<boolean>{return invoke('launch_files_settle',{dropToken,keep});}
