export interface BeatTarget { track: number; staff: number; bar: number; voice: number; beat: number }
export type BaseDocument =
  | { kind: 'blank'; title: string; artist: string; tempo: number; tuning: number[]; measureCount: number }
  | { kind: 'file'; filename: string; bytesBase64: string; sha256: string };
export type EditCommand =
  | { type: 'setNote'; target: BeatTarget; string: number; fret: number }
  | { type: 'removeNote'; target: BeatTarget; string: number }
  | { type: 'setRest'; target: BeatTarget }
  | { type: 'setDuration'; target: BeatTarget; duration: number; dots: number }
  | { type: 'insertBeat'; target: BeatTarget; duration: number; dots: number }
  | { type: 'deleteBeat'; target: BeatTarget }
  | { type: 'appendMeasure' }
  | { type: 'removeMeasure'; bar: number }
  | { type: 'addTrack'; name: string; tuning: number[]; program: number }
  | { type: 'removeTrack'; track: number }
  | { type: 'setTuning'; track: number; tuning: number[] }
  | { type: 'setScoreInfo'; title: string; artist: string; tempo: number };
export interface Project { format: 'TabPlayer'; schemaVersion: 1; engineVersion: '1.8.4'; base: BaseDocument; edits: EditCommand[] }
export interface ProjectSnapshot { project: Project; canUndo: boolean; canRedo: boolean; dirty: boolean; path: string | null }
export interface DocumentCandidate { project: Project; path: string | null }
export const blankProject = (): Project => ({
  format: 'TabPlayer', schemaVersion: 1, engineVersion: '1.8.4',
  base: { kind: 'blank', title: 'Untitled', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 }, edits: [],
});
