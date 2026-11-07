import type { EditCommand, SingleCommand } from './edit-types';
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
/** Whether the partial capo a GP file holds applies to this project. An old log never saw it, so it replays without. A project with no history has nothing to replay, and its first edit marks it; history includes a redo tail (`canRedo`), which the cursor-truncated edit list does not show. */
export const appliesFilePartialCapo=(project:{partialCapo?:true;baselineEdits?:readonly unknown[];edits:readonly unknown[]},canRedo=false)=>project.partialCapo===true||!project.baselineEdits?.length&&!project.edits.length&&!canRedo;
export type ProjectInput = ProjectView | Omit<ProjectView,'schemaVersion'|'assets'|'baselineEdits'> & {schemaVersion:1}
  | Omit<ProjectView,'schemaVersion'|'baselineEdits'> & {schemaVersion:2};
/** The edits a project replays, in order. A `sequence` is one history entry, replayed as the edits it holds. */
export const projectCommands=(project:ProjectInput):SingleCommand[]=>[...('baselineEdits' in project?project.baselineEdits:[]),...project.edits].flatMap(edit=>edit.type==='sequence'?edit.commands:[edit]);
/** Where a document stands with its password to edit: none set, set and not yet given this session (edits refused), or given. */
export type EditProtection = 'none' | 'locked' | 'unlocked';
/** The password protections of a document. Only the state is ever sent here, never a hash, a key or a password. */
export interface Protection { edit: EditProtection; open: boolean }
export const EDIT_LOCKED_MESSAGE = 'This score is locked for editing. Enter its password to make changes.';
/** A password to edit is set and has not been given in this session. Absent protection means none. */
export const isEditPasswordLocked = (snapshot: { protection?: Protection } | null | undefined): boolean => snapshot?.protection?.edit === 'locked';
export interface ProjectSnapshot { project: Project; canUndo: boolean; canRedo: boolean; redoEdit?: EditCommand | null; dirty: boolean; path: string | null; protection?: Protection }
export interface DocumentCandidate { project: Project; path: string | null; token: string }
export const blankProject = (): Project => ({
  format: 'TabPlayer', schemaVersion: 3, engineVersion: '1.8.4', assets: {}, baselineEdits: [],
  base: { kind: 'blank', title: 'Untitled', artist: '', tempo: 120, tuning: [64,59,55,50,45,40], measureCount: 4 }, edits: [],
});
