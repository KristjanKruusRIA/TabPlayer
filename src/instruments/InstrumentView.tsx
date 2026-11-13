import { useI18n, type MessageKey } from '../i18n';
import { useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { model } from '@coderline/alphatab';
import type { PlanNote } from '../audio/types';
import type { EditCommand } from '../edit-types';
import type { BeatTarget } from '../project';
import { formatPitch } from '../tuning';
import { busyGuard } from '../ui';
import { describePartialCapo, getPartialCapo, openStringKey } from '../editor/partial-capo';
import { describeBanjoDrone, fretExists, getBanjoDrone, neckFret, plainFret } from '../editor/banjo-drone';
import { busyHint, entryBeat, entryNotes, fretTarget, hitTarget, instrumentTarget, keyTarget, noBeatHint, padTarget, type EntryAction, type EntryContext, type EntryFollow, type EntryTarget } from './entry';
import { DrumsArt, FretboardArt, KeyboardArt, cymbalIds, neckGeometry, shellHeightOf, surfaceDepthOf, targetDepthOf } from './instrument-art';
import { drumPieces, instrumentHits, kitOrder, ownerOf, percussionInstruments, type Instrument } from './drum-kit';
import type { HeldNote } from './focus';
import { PercussionArt } from './percussion-art';
import { readInstrumentViewPreferences, writeInstrumentViewPreferences, type InstrumentMode, type NoteNames } from './view-preferences';
import './instruments.css';

export interface InstrumentViewProps {
  score: model.Score; track: number; staff: number; notes: readonly PlanNote[];
  /** Names the list of shown notes; it describes sounding notes by default. */
  caption?: string; empty?: string;
  /** Extra controls placed before the view mode. */
  controls?: ReactNode;
  /** Turns the view into an entry surface for the selected beat; its marks then come from the score. */
  entry?: InstrumentEntry;
  /** Tied continuations to show beside the notes; the playback plan has none of its own. */
  held?: readonly HeldNote[];
  /** A panel of its own for one instrument: the view shows only it, without the mode and handedness choices. */
  lockedMode?: Exclude<InstrumentMode, 'auto'>;
  /** Outside entry mode a shown note can be clicked to select it in the score, as a click on the score does: the beat, the string when the note has one and its index in the beat. */
  onSelect?: (target: BeatTarget, string: number | undefined, noteIndex: number | undefined) => void;
}
export interface InstrumentEntry {
  target: BeatTarget | null; busy: boolean;
  /** The string entry continues from; the highest string by default. */
  string?: number;
  onEdit: (command: EditCommand, follow: EntryFollow) => void;
}
/** `hit`, an articulation id, is only known in edit mode, where the score says exactly which hit a note is; playback knows a pitch. */
type ShownNote = Pick<PlanNote, 'id' | 'key' | 'source'> & { hit?: number | null; /** A tied continuation of an earlier note: held, not struck. */ held?: boolean };
/** What a click on a shown note does; null when the view cannot select. */
type NotePicker = ((note: ShownNote) => void) | null;
/** Makes a shown mark a keyboard-reachable button that selects its note. */
function selectable(pick: NotePicker, note: ShownNote, label: string) {
  if (!pick) return {};
  return { role: 'button' as const, tabIndex: 0, 'aria-label': label, onClick: () => pick(note), onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); pick(note); } } };
}
/** Entry mode as the instruments see it: the click rules' context, why targets are disabled, and how an action is sent. */
interface EntryState { ctx: EntryContext; disabled: string | null; send: (action: EntryAction) => void; string?: number }
interface Roving { active: string; setCurrent: (id: string) => void; move: (id: string) => void; ref: (id: string) => (element: Element | null) => void }
/** One tab stop per instrument: the current target is tabbable and arrow keys move between targets. */
function useRoving() {
  const [current, setCurrent] = useState(''), elements = useRef(new Map<string, Element>());
  return (order: readonly string[], fallback: string): Roving => ({
    active: order.includes(current) ? current : fallback, setCurrent,
    move: id => { setCurrent(id); (elements.current.get(id) as HTMLElement | SVGElement | undefined)?.focus(); },
    ref: id => element => { if (element) elements.current.set(id, element); else elements.current.delete(id); },
  });
}
function entryProps(roving: Roving, id: string, entry: EntryState, target: EntryTarget, next: (key: string, id: string) => string | null) {
  const disabled = !!entry.disabled || !target.action;
  const activate = () => { if (!disabled && target.action) entry.send(target.action); };
  return {
    ref: roving.ref(id), role: 'button' as const, tabIndex: roving.active === id ? 0 : -1, 'aria-label': target.name, 'aria-disabled': disabled ? true : undefined, 'data-entry-target': id,
    onClick: activate, onFocus: () => roving.setCurrent(id),
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); activate(); return; }
      const to = next(event.key, id);
      if (to !== null) { event.preventDefault(); event.stopPropagation(); roving.move(to); }
    },
  };
}
const stepKeys = (order: readonly string[], key: string, id: string, forward: readonly string[], back: readonly string[]) => {
  const at = order.indexOf(id);
  if (key === 'Home') return order[0] ?? null;
  if (key === 'End') return order[order.length - 1] ?? null;
  return forward.includes(key) ? order[Math.min(order.length - 1, at + 1)] ?? null : back.includes(key) ? order[Math.max(0, at - 1)] ?? null : null;
};
const modeNames: Record<Exclude<InstrumentMode,'auto'>,MessageKey> = {guitar:'instruments.mode_guitar',bass:'instruments.mode_bass',drums:'instruments.mode_drums',keys:'instruments.mode_keys',both:'instruments.mode_both'};
/** A pitch as the user wants notes named: with its octave, or the letter alone. */
const noteLabel = (key: number, names: NoteNames) => names === 'letter' ? formatPitch(key).replace(/-?\d+$/, '') : formatPitch(key);
type FretPosition = { id: string; key: number; string: number; fret: number; note?: ShownNote; held?: boolean };
const blackKeys = new Set([1,3,6,8,10]);
const percussionNames = [
  'Acoustic bass drum','Bass drum','Side stick','Acoustic snare','Hand clap','Electric snare','Low floor tom','Closed hi-hat','High floor tom','Pedal hi-hat','Low tom','Open hi-hat','Low-mid tom','Hi-mid tom','Crash cymbal 1','High tom','Ride cymbal 1','Chinese cymbal','Ride bell','Tambourine','Splash cymbal','Cowbell','Crash cymbal 2','Vibraslap','Ride cymbal 2','Hi bongo','Low bongo','Mute hi conga','Open hi conga','Low conga','High timbale','Low timbale','High agogo','Low agogo','Cabasa','Maracas','Short whistle','Long whistle','Short guiro','Long guiro','Claves','Hi wood block','Low wood block','Mute cuica','Open cuica','Mute triangle','Open triangle',
];
const percussionName = (key: number) => percussionNames[key-35] ?? `Percussion ${formatPitch(key)} (${key})`;

function Fretboard({staff, notes, mode, leftHanded, pick, entry}: {staff: model.Staff; notes: readonly ShownNote[]; mode: 'guitar' | 'bass'; leftHanded: boolean; pick: NotePicker; entry?: EntryState}) {
  const { t } = useI18n();
  const rove=useRoving();
  if (!staff.tuning.length) return <p className="instrument-empty">{t('instruments.no_tuning')}</p>;
  const order = entry ? staff.tuning.flatMap((_,index)=>Array.from({length:Math.max(24,...entry.ctx.notes.map(note=>Math.ceil(note.fret)))+1},(_,fret)=>`${staff.tuning.length-index}/${fret}`)) : [];
  const start = `${entry?.string && entry.string >= 1 && entry.string <= staff.tuning.length ? entry.string : staff.tuning.length}/0`, roving = rove(order, start);
  const positions: FretPosition[] = [], held = new Set(notes.filter(note => note.held).map(note => note.id));
  if (entry) for (const note of entry.ctx.notes) { if (note.string) positions.push({id: note.id, key: note.key, string: note.string, fret: note.fret, held: held.has(note.id)}); }
  else for (const note of notes) {
    if (note.source.target.staff !== staff.index) continue;
    const {target,string} = note.source, beat = staff.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
    const source = beat?.notes.find(n => n.string === string);
    if (string < 1 || string > staff.tuning.length || (!source && !beat?.deadSlapped)) continue;
    // Trills and ornaments retain their source string; harmonics retain their
    // authored touch position rather than moving to a guessed sounding fret.
    const fret = beat?.deadSlapped ? 0 : source!.harmonicType === 0 && (!source!.isDead || fretExists(staff, string, source!.fret)) ? neckFret(staff, string, plainFret(staff, string, source!.fret) + note.key - source!.realValue) : source!.fret;
    if (fret >= 0) positions.push({id: note.id, key: note.key, string, fret, note, held: note.held});
  }
  const maxFret = Math.max(24,...positions.map(p => Math.ceil(p.fret))), {left,top,row,width,boundary,position} = neckGeometry(staff.tuning.length,mode,maxFret);
  const openKeys = staff.tuning.map((_,index)=>formatPitch(openStringKey(staff,staff.tuning.length-index))).join(',');
  const name=`${mode === 'bass' ? t('instruments.fretboard_bass') : t('instruments.fretboard_guitar')}${leftHanded ? t('instruments.left_handed_suffix') : ''}`;
  const partial = describePartialCapo(getPartialCapo(staff)), drone = getBanjoDrone(staff);
  return <>
    <p className="instrument-detail">{[t('instruments.detail_staff',{staff:staff.index+1,strings:staff.tuning.length,capo:staff.capo}),staff.capo?t('instruments.detail_capo_relative'):'',partial?t('instruments.detail_partial_relative',{description:partial}):'',drone?t('instruments.detail_drone_follows',{description:describeBanjoDrone(drone)}):'',t('instruments.detail_open',{pitches:staff.tuning.map((_,index)=>formatPitch(openStringKey(staff,staff.tuning.length-index))).join(' ')})].filter(Boolean).join(' · ')}</p>
    <div className="instrument-canvas instrument-fretboard"><svg role={entry?'group':'img'} aria-label={name} viewBox={`0 0 ${width} 226`}>
      <title>{name}</title>
      {/* The hardware is one memoised layer; only the notes and entry targets below are drawn again as playback moves. */}
      <FretboardArt strings={staff.tuning.length} openKeys={openKeys} mode={mode} leftHanded={leftHanded} maxFret={maxFret}/>
      <g data-handedness={leftHanded?'left':'right'} transform={leftHanded?`matrix(-1 0 0 1 ${width} 0)`:undefined}>
      {[...positions.filter(p=>p.held),...positions.filter(p=>!p.held)].map(({id: noteId,key,string,fret,note,held: tied})=><g key={noteId} className={`fret-note${tied?' held':''}${pick?' selectable':''}`} data-note-id={noteId} data-string={string} data-fret={fret} data-key={key} data-held={tied?'true':undefined} {...(note?selectable(pick,note,t('instruments.select_note',{note:formatPitch(key)})):{})}>
        <circle className="fret-note-halo" cx={position(fret)} cy={top+(staff.tuning.length-string)*row} r="6.6"/><circle cx={position(fret)} cy={top+(staff.tuning.length-string)*row} r="4"/><title>{tied?t('instruments.held_note',{pitch:formatPitch(key),string,fret}):`${formatPitch(key)} · string ${string} · fret ${fret}`}</title>
      </g>)}
      {entry ? staff.tuning.map((_,index)=>{
        // Neighbouring strings split the space between them; only the outer strings reach further out, to a 12-unit target.
        const string = staff.tuning.length-index, y = top+index*row, outer = Math.max(row/2, 6);
        const upper = y-(index===0 ? outer : row/2), lower = y+(index===staff.tuning.length-1 ? outer : row/2);
        return Array.from({length:maxFret+1},(_,fret)=>{
          const item = `${string}/${fret}`, x = fret===0 ? left-31 : boundary(fret-1), width = fret===0 ? 28 : boundary(fret)-boundary(fret-1);
          // Arrows follow the picture: a mirrored neck swaps left and right.
          const move = (key: string, from: string) => {
            const [s, f] = from.split('/').map(Number), visual = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0, dFret = leftHanded ? -visual : visual;
            const ns = key === 'ArrowUp' ? s+1 : key === 'ArrowDown' ? s-1 : s, nf = key === 'Home' ? 0 : key === 'End' ? maxFret : f+dFret;
            if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(key) || ns < 1 || ns > staff.tuning.length || nf < 0 || nf > maxFret) return null;
            return `${ns}/${nf}`;
          };
          return <rect key={item} className="entry-target" data-entry-string={string} data-entry-fret={fret} x={x} y={upper} width={width} height={lower-upper} {...entryProps(roving, item, entry, fretTarget(entry.ctx, string, fret), move)}/>;
        });
      }) : null}
      </g>
    </svg></div>
  </>;
}

function Keyboard({staves,notes,compact,names,pick,entry}: {staves: readonly model.Staff[]; notes: readonly ShownNote[]; compact:boolean; names: NoteNames; pick: NotePicker; entry?: EntryState}) {
  const { t } = useI18n();
  const rove=useRoving();
  const sourceRange = useMemo(()=>{
    let low=128,high=-1;
    for (const staff of staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) {
      if (staff.isPercussion) continue;
      const key=note.realValue; low=Math.min(low,key); high=Math.max(high,key);
    }
    return high<low ? [48,83] : [low,high];
  },[staves]);
  // An empty beat still gets at least two octaves around middle C to click on.
  const active = new Set(notes.map(note=>note.key)), tiedKeys = new Set(notes.filter(note=>note.held&&!notes.some(other=>!other.held&&other.key===note.key)).map(note=>note.key)), around = entry && !active.size ? [48,72] : [], low = Math.max(0,Math.floor(Math.min(sourceRange[0],...active,...around)/12)*12), high = Math.min(127,Math.max(low+35,Math.ceil((Math.max(sourceRange[1],...active,...around)+1)/12)*12-1));
  const white: {key:number;x:number}[] = [], black: {key:number;x:number}[] = [], keyWidth = 28;
  for (let key=low;key<=high;key++) {
    if (blackKeys.has(key%12)) black.push({key,x:white.length*keyWidth-8}); else white.push({key,x:white.length*keyWidth});
  }
  const order = [...white,...black].map(item=>item.key).sort((a,b)=>a-b).map(String), roving = rove(order, order.includes('60') ? '60' : order[0]);
  const shown = new Map<number, ShownNote>(); for (const note of [...notes.filter(item=>!item.held),...notes.filter(item=>item.held)]) if (!shown.has(note.key)) shown.set(note.key, note);
  const props = (key: number) => entry ? {className: 'entry-target', ...entryProps(roving, String(key), entry, keyTarget(entry.ctx, key), (name, from) => stepKeys(order, name, from, ['ArrowRight','ArrowUp'], ['ArrowLeft','ArrowDown']))} : shown.has(key) ? selectable(pick, shown.get(key)!, t('instruments.select_note',{note:noteLabel(key,names)})) : {};
  const total=white.length*keyWidth;
  return <div className="instrument-canvas instrument-keyboard"><svg role={entry?'group':'img'} aria-label={t('instruments.keyboard')} viewBox={`0 0 ${total} 125`} style={{minWidth:total*(compact?80/125:1)}}>
    <title>{`Keyboard · sounding pitches ${formatPitch(low)} to ${formatPitch(high)}`}</title>
    {/* The keys are one memoised layer; each key below only holds its hit area, its lit mark and its label. */}
    <KeyboardArt low={low} high={high}/>
    {white.map(({key,x})=><g key={key} data-key={key} data-key-color="white" data-active={active.has(key)} data-held={tiedKeys.has(key)?'true':undefined} {...props(key)} className={`piano-key white${active.has(key)?' active':''}${tiedKeys.has(key)?' held':''}${entry?' entry-target':''}${!entry&&pick&&shown.has(key)?' selectable':''}`}><rect className="key-area" x={x+1} y="9" width={keyWidth-2} height="110" rx="3"/>{active.has(key)?<rect className="key-hit" x={x+3} y="88" width={keyWidth-6} height="27" rx="3"/>:null}{active.has(key)?<text x={x+keyWidth/2} y="107" textAnchor="middle">{noteLabel(key,names)}</text>:null}<title>{formatPitch(key)}</title></g>)}
    {black.map(({key,x})=><g key={key} data-key={key} data-key-color="black" data-active={active.has(key)} data-held={tiedKeys.has(key)?'true':undefined} {...props(key)} className={`piano-key black${active.has(key)?' active':''}${tiedKeys.has(key)?' held':''}${entry?' entry-target':''}${!entry&&pick&&shown.has(key)?' selectable':''}`}><rect className="key-area" x={x} y="8" width="16" height="69" rx="3"/>{active.has(key)?<rect className="key-hit" x={x+2} y="53" width="12" height="19" rx="2"/>:null}{active.has(key)?<text x={x+8} y="66" textAnchor="middle">{noteLabel(key,names)}</text>:null}<title>{formatPitch(key)}</title></g>)}
  </svg></div>;
}

function DrumKit({notes, entry}: {notes: readonly ShownNote[]; entry?: EntryState}) {
  const { t } = useI18n();
  const rove=useRoving(), [focused,setFocused]=useState<string|null>(null);
  // Edit mode lights the instrument that owns each hit; the pitch only decides for notes without an articulation, as in playback.
  const struck = notes.filter(note=>note.hit!=null), keys = new Set(notes.filter(note=>note.hit==null).map(note=>note.key)), kitKeys = new Set([...drumPieces,...percussionInstruments].flatMap(piece=>piece.keys));
  const owners = new Map(struck.map(note=>[note, entry ? ownerOf(entry.ctx.staff.track, note.hit!) : undefined])), held = new Set([...owners.values()].flatMap(item=>item?[item.id]:[]));
  const auxiliary = [...new Set([...[...keys].filter(key=>!kitKeys.has(key)),...struck.filter(note=>!owners.get(note)).map(note=>note.key)])];
  const lit = (item: Instrument) => held.has(item.id) || item.keys.some(key=>keys.has(key));
  const kit = [...drumPieces].sort((a,b)=>a.x-b.x), order = entry ? [...kit.map(piece=>piece.id),...percussionInstruments.map(item=>item.id),...auxiliary.map(key=>`pad/${key}`)] : [], roving = rove(order, order[0] ?? '');
  const chosen = entry && focused ? [...drumPieces,...percussionInstruments].find(item=>item.id===focused) : undefined, hits = entry && chosen ? instrumentHits(entry.ctx.staff.track, chosen) : [];
  const move = (name: string, from: string) => stepKeys(order, name, from, ['ArrowRight','ArrowDown'], ['ArrowLeft','ArrowUp']);
  // The hits show while their instrument or the row itself has focus, so reaching the row from the instrument keeps them.
  const focusIn = (event: ReactFocusEvent) => { const id = (event.target as Element).closest('[data-entry-target]')?.getAttribute('data-entry-target'); if (id) setFocused(id.startsWith('pad/') ? null : id); };
  const focusOut = (event: ReactFocusEvent) => { if (document.activeElement === event.target) return; const to = event.relatedTarget as Element | null, view = event.currentTarget.closest('.instrument-view'); if (!to || !view?.contains(to) || !to.closest('[data-entry-target],.drum-hits')) setFocused(null); };
  const struckNames = (item: Instrument) => [...item.keys.filter(key=>keys.has(key)).map(percussionName),...(entry ? struck.filter(note=>owners.get(note)===item).map(note=>instrumentHits(entry.ctx.staff.track, item).find(hit=>hit.id===note.hit)?.name ?? percussionName(note.key)) : [])];
  return <>
    <div className="instrument-canvas instrument-drums" onFocus={focusIn} onBlur={focusOut}><svg role={entry?'group':'img'} aria-label={t('instruments.drum_kit')} viewBox="0 0 860 300">
      <title>{t('instruments.drum_kit_active')}</title>
      {/* The kit is one memoised layer; each piece below only holds its hit area, its lit mark and its name when struck. */}
      <DrumsArt pieces={drumPieces}/>
      {kitOrder(drumPieces).map(piece=>{
        const active=lit(piece), cymbal=cymbalIds.includes(piece.id);
        const r=piece.r,ry=surfaceDepthOf(piece),shellHeight=shellHeightOf(piece),upright=`rotate(${-piece.tilt})`;
        return <g key={piece.id} data-drum={piece.id} data-active={active} className={`drum-piece${cymbal?' cymbal':''}${active?' active':''}${entry?' entry-target':''}`} transform={`translate(${piece.x},${piece.y}) rotate(${piece.tilt})`} {...(entry?entryProps(roving, piece.id, entry, instrumentTarget(entry.ctx, piece), move):{})}>
          <title>{`${piece.label}${active?` · ${struckNames(piece).join(', ')}`:''}`}</title>
          {cymbal ? <ellipse className="drum-area" cx="0" cy="0" rx={r} ry={targetDepthOf(piece)}/>
            : piece.id.startsWith('kick') ? <circle className="drum-area" cx="0" cy="0" r={r}/>
            : <path className="drum-area" d={`M${-r} 0V${shellHeight}C${-r} ${shellHeight+ry*1.33} ${r} ${shellHeight+ry*1.33} ${r} ${shellHeight}V0A${r} ${ry} 0 0 0 ${-r} 0Z`}/>}
          {active ? (cymbal ? <ellipse className="drum-hit" cx="0" cy="0" rx={r-2} ry={ry-1}/> : piece.id.startsWith('kick') ? <circle className="drum-hit" cx="0" cy="0" r={r-5}/> : <ellipse className="drum-hit" cx="0" cy="0" rx={r-3} ry={ry-2}/>) : null}
          {active ? <text className={`drum-label${cymbal?'':' on-head'}`} x="0" y={cymbal?targetDepthOf(piece)+11:3} textAnchor="middle" transform={upright}>{piece.label}</text> : null}
        </g>;
      })}
    </svg></div>
    <div className="instrument-percussion" role="group" aria-label={t('instruments.percussion')} onFocus={focusIn} onBlur={focusOut}>{percussionInstruments.map(item=>{const on=lit(item);return <div key={item.id} className={`percussion-item${on?' active':''}${entry?' entry-target':''}`} data-percussion={item.id} data-active={on} title={item.label} {...(entry?entryProps(roving, item.id, entry, instrumentTarget(entry.ctx, item), move):{})}><PercussionArt id={item.id}/><span>{item.label}</span></div>;})}</div>
    {entry ? <div className="drum-hits-slot">{chosen&&hits.length>1 ? <div className="drum-hits" role="group" aria-label={`${chosen.label} hits`} onFocus={focusIn} onBlur={focusOut} onMouseDown={event=>event.preventDefault()}>{hits.map(hit=>{const pressed=entry.ctx.notes.some(note=>note.articulation===hit.id),target=hitTarget(entry.ctx,hit.id,hit.label);return <button type="button" key={hit.id} aria-pressed={pressed} {...busyGuard<HTMLButtonElement>({unavailable:!!entry.disabled||!target.action,onClick:()=>{if(target.action)entry.send(target.action);}})}>{hit.name}</button>;})}</div> : null}</div> : null}
    {auxiliary.length>0 ? <div className="instrument-percussion-pads" aria-label={t('instruments.additional_percussion')} onFocus={focusIn} onBlur={focusOut}>{auxiliary.map(key=><span className={entry?'percussion-pad entry-target':'percussion-pad'} data-percussion-key={key} data-active="true" key={key} {...(entry?entryProps(roving, `pad/${key}`, entry, padTarget(entry.ctx, key, percussionName(key)), move):{})}>{percussionName(key)}</span>)}</div> : null}
  </>;
}

export function InstrumentView({score,track:trackIndex,staff:staffIndex,notes,caption: captionProp,empty: emptyProp,controls,entry:entryProps_,held,lockedMode,onSelect}: InstrumentViewProps) {
  const { t } = useI18n();
  const caption = captionProp ?? t('instruments.caption_playing'), empty = emptyProp ?? t('instruments.empty_playing');
  const [saved] = useState(readInstrumentViewPreferences), [requestedMode,setRequestedMode] = useState<InstrumentMode>('auto'), [neckChoice,setNeckChoice] = useState<'guitar'|'bass'|null>(saved.neck), track = score.tracks[trackIndex], staff = track.staves[staffIndex];
  const [expanded,setExpandedNow] = useState(saved.expanded), [leftHanded,setLeftHanded] = useState(saved.leftHanded), [noteNames,setNoteNamesNow] = useState<NoteNames>(saved.noteNames);
  // These are the user's own view options: each choice is kept for the next view and still applies here when storage refuses it.
  const handedness = (left: boolean) => { setLeftHanded(left); writeInstrumentViewPreferences({ leftHanded: left }); };
  // The mode itself is per track (Auto follows the track), so only the neck it chose is kept.
  const setMode = (value: InstrumentMode) => { setRequestedMode(value); const neckKind = value==='guitar'||value==='bass' ? value : undefined; if (neckKind) setNeckChoice(neckKind); if (neckKind) writeInstrumentViewPreferences({ neck: neckKind }); };
  const setExpanded = (value: boolean) => { setExpandedNow(value); writeInstrumentViewPreferences({ expanded: value }); };
  const setNoteNames = (value: NoteNames) => { setNoteNamesNow(value); writeInstrumentViewPreferences({ noteNames: value }); };
  const automatic: Exclude<InstrumentMode,'auto'> = staff.isPercussion ? 'drums' : track.playbackInfo.program>=24 && track.playbackInfo.program<=31 ? 'guitar' : track.playbackInfo.program>=32 && track.playbackInfo.program<=39 ? 'bass' : 'keys';
  // A percussion staff has no neck, so the combined view falls back to the drum kit.
  const mode = lockedMode ?? (requestedMode==='auto' || requestedMode==='both' && staff.isPercussion ? automatic : requestedMode), neck = neckChoice ?? (automatic==='bass' ? 'bass' : 'guitar');
  // The combined view shows one staff on both instruments so they always agree.
  const entryTarget = entryProps_?.target ?? null, entryLive = !!entryProps_ && !!entryTarget && entryTarget.track===trackIndex && entryTarget.staff===staffIndex;
  const entryBeatNow = entryLive ? entryBeat(score, entryTarget) : null;
  // Edit mode reads the selected beat from the score so marks follow each edit at once.
  const entry: EntryState | undefined = (()=>{
    if (!entryProps_) return undefined;
    const ctx: EntryContext = {target: entryTarget ?? {track: trackIndex, staff: staffIndex, bar: 0, voice: 0, beat: 0}, staff, notes: entryBeatNow ? entryNotes(staff, entryBeatNow) : []};
    return {ctx, string: entryProps_.string, disabled: !entryBeatNow ? noBeatHint : entryProps_.busy ? busyHint : null, send: action => entryProps_.onEdit(action.command, action.follow)};
  })();
  const pick: NotePicker = onSelect && !entry ? note => {
    const {target, string} = note.source, beat = score.tracks[target.track]?.staves[target.staff]?.bars[target.bar]?.voices[target.voice]?.beats[target.beat];
    const index = beat ? beat.notes.findIndex(item => string > 0 ? item.string === string : item.realValue === note.key) : -1;
    onSelect(target, string > 0 ? string : undefined, index >= 0 ? index : undefined);
  } : null;
  const entryNow = entry && entryBeatNow ? entry.ctx.notes.map((note):ShownNote=>({id: note.id, key: note.key, source: {target: entry.ctx.target, string: note.string}, hit: note.articulation, held: !!entryBeatNow.notes[note.index]?.isTieDestination})) : null;
  const inView = (note: Pick<PlanNote,'source'>) => note.source.target.track===trackIndex && (mode!=='both' || note.source.target.staff===staffIndex);
  const active: readonly ShownNote[] = entryNow ?? (entry ? [] : [...notes.filter(inView),...(held??[]).filter(inView).map((note):ShownNote=>({...note,held:true}))]);
  const kindHint = !entry || entry.disabled ? null : staff.isPercussion && (mode==='keys'||mode==='both') ? t('instruments.cant_enter_keys_on_perc') : !staff.isPercussion && mode==='drums' ? t('instruments.cant_enter_drums_on_pitched') : null;
  const staves = useMemo(()=>mode==='both' ? [staff] : track.staves,[mode,staff,track]);
  const labels = [...new Set(active.map(note=>mode!=='drums'?note.held?t('instruments.note_tied',{note:noteLabel(note.key,noteNames)}):noteLabel(note.key,noteNames):note.hit!=null?ownerOf(track,note.hit)?.label??percussionName(note.key):percussionName(note.key)))], hint = entry?.disabled ?? kindHint;
  return <div className="instrument-view" data-size={expanded?'expanded':'compact'}>
    <div className="instrument-header"><h3>{track.name}<span> · {t(modeNames[mode])}</span></h3><div className="instrument-controls">{controls}{lockedMode ? null : <label>{t('instruments.view_mode')}<select value={requestedMode==='both'&&staff.isPercussion?'auto':requestedMode} onChange={event=>setMode(event.target.value as InstrumentMode)}><option value="auto">{t('instruments.mode_auto')}</option><option value="guitar">{t('instruments.mode_guitar')}</option><option value="bass">{t('instruments.mode_bass')}</option><option value="drums">{t('instruments.mode_drums')}</option><option value="keys">{t('instruments.mode_keys')}</option><option value="both" disabled={staff.isPercussion}>{t('instruments.mode_both')}</option></select></label>}{mode==='guitar'||mode==='bass'||mode==='both' ? <label className="instrument-check"><input type="checkbox" checked={leftHanded} onChange={event=>handedness(event.target.checked)}/>{t('instruments.left_handed')}</label> : null}{mode!=='drums' ? <label>{t('instruments.note_names')}<select value={noteNames} onChange={event=>setNoteNames(event.target.value as NoteNames)}><option value="octave">{t('instruments.note_names_octave')}</option><option value="letter">{t('instruments.note_names_letter')}</option></select></label> : null}<button type="button" aria-label={expanded?t('instruments.compact_view'):t('instruments.expand_view')} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?t('instruments.compact'):t('instruments.expand')}</button></div></div>
    {mode==='both' ? <><Fretboard staff={staff} notes={active} mode={neck} leftHanded={leftHanded} pick={pick} entry={entry}/><Keyboard staves={staves} notes={active} compact={!expanded} names={noteNames} pick={pick} entry={entry}/></> : mode==='guitar'||mode==='bass' ? <Fretboard staff={staff} notes={active} mode={mode} leftHanded={leftHanded} pick={pick} entry={entry}/> : mode==='drums' ? <DrumKit notes={active} entry={entry}/> : <Keyboard staves={staves} notes={active} compact={!expanded} names={noteNames} pick={pick} entry={entry}/>}
    {entry&&hint ? <p className="instrument-entry-hint" role="status">{hint}</p> : null}
    <div className="instrument-playing" role="group" aria-label={caption}>{labels.length ? labels.map(label=><span className="instrument-note" key={label}>{label}</span>) : <span className="instrument-empty">{empty}</span>}</div>
  </div>;
}
