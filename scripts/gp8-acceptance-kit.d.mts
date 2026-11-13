export const DEFAULT_DIR: string;
export const GPIF: string;
export const BPM: number;
export interface KitCase { name: string; time?: [number, number]; beats?: number; fermata?: { type: string; length: number }; build: (c: unknown) => void }
export interface KitFamily { id: string; title: string; look: string; cases: KitCase[]; elements: string[]; tracks?: { name: string }[]; midi?: { timing: boolean; why: string }; control?: boolean }
export const FAMILIES: KitFamily[];
export interface Expected { notes: number; onsets: number[]; quarters: number }
export function buildFamilyFile(family: KitFamily): { bytes: Uint8Array; expected: Expected };
export function fileName(index: number, family: KitFamily): string;
export function checklistText(entries: { family: KitFamily; name: string }[]): string;
export function writeKit(dir?: string): { out: string; files: string[]; warnings: string[] };
export interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[]; text: string; parent: XmlNode | null }
export function parseXml(text: string): { root: XmlNode; error: string | null };
export function select(root: XmlNode, selector: string): XmlNode[];
export function canonical(node: XmlNode): string;
export interface SelectorResult { selector: string; written: number; returned: number; status: 'none' | 'absent' | 'added' | 'same' | 'changed' | 'error'; detail: string }
export function compareSelector(selector: string, writtenRoot: XmlNode, returnedRoot: XmlNode): SelectorResult;
export interface MidiCompare { observedNotes: number; expectedNotes: number; noteCountMatches: boolean; missingCount: number; extraCount: number; timingMatches: boolean; timingNote?: string; allKeysZero: boolean; firstTempoBpm: number | null; endSeconds: number; [key: string]: unknown }
export interface FamilyResult { id: string; name: string; title: string; original: { status: string; detail: string }; saved: { status: string; detail: string }; midi: { status: string; detail: string }; selectors: SelectorResult[]; midiCompare: MidiCompare | null; control: Record<string, unknown> | null; notes: string[] }
export interface CollectResult { dir: string; problems: string[]; families: FamilyResult[]; unrecognised: string[] }
export function collectKit(dir?: string): CollectResult;
export function resultsMarkdown(result: CollectResult): string;
export function main(argv: string[]): number;
