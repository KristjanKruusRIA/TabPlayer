export const LANGUAGES: string[];
export const COLUMNS: string[];
export interface ReviewTerm { id: string; lang: string; side: 'translation' | 'english' | 'key'; kind: 'check' | 'chosen' | 'forbidden'; match: string | RegExp; note: string; source: string }
export const REVIEW_TERMS: ReviewTerm[];
export interface ReviewRow { key: string; english: string; translation: string; phEnglish: string[]; phTranslation: string[]; flags: string[]; details: string[] }
export function loadCatalog(lang: string, root?: string): Promise<{ catalog: Record<string, string>; lines: Map<string, number>; file: string }>;
export function placeholders(text: string): string[];
export function edges(text: string): { lead: string; trail: string };
export function edgeDifference(english: string, translation: string): string;
export function buildRows(lang: string, english: Record<string, string>, translated: Record<string, string>, terms?: ReviewTerm[]): ReviewRow[];
export function countFlags(rows: ReviewRow[]): Record<string, number>;
export function areaOf(key: string): string;
export function groupByArea(rows: ReviewRow[]): Map<string, ReviewRow[]>;
export function csvField(value: unknown): string;
export function csvLine(fields: unknown[]): string;
export function rowsToCsv(rows: ReviewRow[]): string;
export function rowsToMarkdown(lang: string, rows: ReviewRow[]): string;
export function parseCsv(text: string): string[][];
export interface PlanChange { row: number; key: string; line: number | null; from: string; to: string }
export function planApply(lang: string, csvRows: string[][], english: Record<string, string>, translated: Record<string, string>, lineOf?: Map<string, number>): { changes: PlanChange[]; refused: { row: number; key: string; reason: string }[]; unchanged: number };
export function describePlan(lang: string, plan: ReturnType<typeof planApply>): string[];
