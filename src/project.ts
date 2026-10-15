import type { EditCommand } from './edit-types';
export type { EditCommand } from './edit-types';
export interface BeatTarget { track: number; staff: number; bar: number; voice: number; beat: number }
export type BaseDocument =
  | { kind: 'blank'; title: string; artist: string; tempo: number; tuning: number[]; measureCount: number }
  | { kind: 'file'; filename: string; bytesBase64: string; sha256: string };
export interface AssetInfo { filename: string; mediaType: string; byteLength: number }
export interface AssetCandidate { token:string; assetId:string; info:AssetInfo; durationMs?:number }
export interface ProjectView { format: 'TabPlayer'; schemaVersion: 3; engineVersion: '1.8.4'; base: BaseDocument; baselineEdits: EditCommand[]; edits: EditCommand[]; assets: Record<string,AssetInfo> }
export type Project = ProjectView;
export type ProjectInput = ProjectView | Omit<ProjectView,'schemaVersion'|'assets'|'baselineEdits'> & {schemaVersion:1}
  | Omit<ProjectView,'schemaVersion'|'baselineEdits'> & {schemaVersion:2};
export const projectCommands=(project:ProjectInput):EditCommand[]=>[...('baselineEdits' in project?project.baselineEdits:[]),...project.edits];
export interface ProjectSnapshot { project: Project; canUndo: boolean; canRedo: boolean; redoEdit?: EditCommand | null; dirty: boolean; path: string | null }
export interface DocumentCandidate { project: Project; path: string | null; token: string }
export const blankProject = (): Project => ({
  format: 'TabPlayer', schemaVersion: 3, engineVersion: '1.8.4', assets: {}, baselineEdits: [],
  base: { kind: 'blank', title: 'Untitled', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 }, edits: [],
});
