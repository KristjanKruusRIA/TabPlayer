import type { EditCommand } from './edit-types';
export type { EditCommand } from './edit-types';
export interface BeatTarget { track: number; staff: number; bar: number; voice: number; beat: number }
export type BaseDocument =
  | { kind: 'blank'; title: string; artist: string; tempo: number; tuning: number[]; measureCount: number }
  | { kind: 'file'; filename: string; bytesBase64: string; sha256: string };
export interface AssetInfo { filename: string; mediaType: string; byteLength: number }
export interface AssetCandidate { token:string; assetId:string; info:AssetInfo; durationMs?:number }
/** A lock on a document. Only finalizing exists; password locks can add kinds later. */
export type DocumentLock = { kind: 'finalized' };
export const FINALIZED_MESSAGE = 'This document is finalized. Unfinalize it to make changes.';
export interface ProjectView { format: 'TabPlayer'; schemaVersion: 3; engineVersion: '1.8.4'; base: BaseDocument; baselineEdits: EditCommand[]; edits: EditCommand[]; assets: Record<string,AssetInfo>; lock?: DocumentLock;
  /** Present (true) once a score read from a file was edited on a build with partial capo support: the file's partial capo then applies. Absent keeps every earlier project exactly as it replayed. */
  partialCapo?: true }
export const isFinalized = (project: { lock?: DocumentLock | null } | null | undefined): boolean => project?.lock?.kind === 'finalized';
export type Project = ProjectView;
/** Whether the partial capo a GP file holds applies to this project. An old log never saw it, so it replays without; a project with no edits has nothing to replay, and the first edit marks it. */
export const appliesFilePartialCapo=(project:{partialCapo?:true;baselineEdits?:readonly unknown[];edits:readonly unknown[]})=>project.partialCapo===true||!project.baselineEdits?.length&&!project.edits.length;
export type ProjectInput = ProjectView | Omit<ProjectView,'schemaVersion'|'assets'|'baselineEdits'> & {schemaVersion:1}
  | Omit<ProjectView,'schemaVersion'|'baselineEdits'> & {schemaVersion:2};
export const projectCommands=(project:ProjectInput):EditCommand[]=>[...('baselineEdits' in project?project.baselineEdits:[]),...project.edits];
export interface ProjectSnapshot { project: Project; canUndo: boolean; canRedo: boolean; redoEdit?: EditCommand | null; dirty: boolean; path: string | null }
export interface DocumentCandidate { project: Project; path: string | null; token: string }
export const blankProject = (): Project => ({
  format: 'TabPlayer', schemaVersion: 3, engineVersion: '1.8.4', assets: {}, baselineEdits: [],
  base: { kind: 'blank', title: 'Untitled', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 }, edits: [],
});
