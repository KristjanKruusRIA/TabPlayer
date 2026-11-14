// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { model, Settings } from '@coderline/alphatab';
import { EditorPanel } from '../EditorPanel';
import { music, target } from '../editor/fixtures';
import { MixerView } from '../mixer/MixerView';
import { SoundRig } from '../rig/SoundRig';
import { InstrumentView } from '../instruments/InstrumentView';
import { buildPlaybackPlan } from '../audio/plan';
import { soundPreset } from '../audio/sound-model';
import { previewEdit } from '../engine';
import { blankProject } from '../project';
import type { NativePlaybackController } from '../audio/NativePlaybackController';
import { SoundPanel } from '../audio/SoundPanel';
import { CurveEditor, BEND_PRESETS } from '../editor/CurveEditor';
import { SavedTuningsDialog } from '../tuning/SavedTuningsDialog';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ format: 'tabplayer-tuning-library', version: 1, entries: [] }))
}));
import { catalogs, setLanguagePreference, type MessageKey, type SupportedLanguage } from './index';

afterEach(() => { cleanup(); setLanguagePreference('en'); localStorage.clear(); });
beforeEach(() => { localStorage.clear(); setLanguagePreference('en'); });

/** What a person (or a screen reader) is offered on the page: every label and every text of an interactive or labelled element. */
function names(container: HTMLElement): Set<string> {
  const found = new Set<string>();
  const add = (text: string | null | undefined) => { const value = (text ?? '').replace(/\s+/g, ' ').trim(); if (value) found.add(value); };
  container.querySelectorAll('details').forEach(details => { details.open = true; });
  container.querySelectorAll('button,summary,label,legend,option,h2,h3,h4,[role=tab],[role=radio],[role=img],[role=group],[role=region],[role=tablist],[role=tabpanel],[role=gridcell],title,p').forEach(element => {
    add(element.textContent);
    add(element.getAttribute('aria-label'));
    add(element.getAttribute('title'));
  });
  container.querySelectorAll('[aria-label]').forEach(element => add(element.getAttribute('aria-label')));
  return found;
}

const fakePlayback = () => ({ subscribe: () => () => {}, getState: () => null, devices: vi.fn(async () => []), deviceId: () => null, selectDevice: vi.fn(), soundPreview: () => null, previewSound: vi.fn(async () => {}) });

function Rig() {
  const [track, setTrack] = useState('guitar');
  return <SoundRig trackId={track} sound={soundPreset('lead', 'green-guitar')} busy={false} playback={fakePlayback() as unknown as NativePlaybackController}
    tracks={[{ id: 'guitar', name: 'Lead Guitar', program: 29 }, { id: 'drums', name: 'Drums', program: 0, percussion: true }]} onTrack={setTrack} onEdit={async () => {}} />;
}

function guitarScore() {
  const score = new model.Score(), track = new model.Track(); track.name = 'Guitar'; track.playbackInfo.program = 25;
  score.addTrack(track); score.addMasterBar(new model.MasterBar());
  const staff = new model.Staff(); staff.stringTuning.tunings = [64, 59, 55, 50, 45, 40]; staff.capo = 2; track.addStaff(staff);
  const bar = new model.Bar(), voice = new model.Voice(), beat = new model.Beat(); beat.isEmpty = false; beat.duration = model.Duration.Quarter;
  const note = new model.Note(); note.string = 6; note.fret = 3; beat.addNote(note); voice.addBeat(beat); bar.addVoice(voice); staff.addBar(bar);
  score.finish(new Settings());
  return score;
}

interface Surface { title: string; mount: () => ReturnType<typeof render>; sample: string[]; keys: MessageKey[]; }
const editorProps = () => ({ score: music(), target, string: 6, fret: 3, noteIndex: null, busy: false, musicSelection: null,
  onSelectNote: vi.fn(), onSelect: vi.fn(), onString: vi.fn(), onFret: vi.fn(), onEdit: vi.fn(), onMusicSelection: vi.fn(), onChord: vi.fn(), onScales: vi.fn() });
const mixerScore = () => previewEdit(previewEdit(blankProject(), { type: 'setRest', target }).project, { type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: 33 }).score;

const surfaces: Surface[] = [
  {
    title: 'editor',
    mount: () => render(<EditorPanel {...editorProps()} />),
    sample: ['Set note', 'Remove note', 'Apply rhythm', 'Make rest', 'Delete beat', 'Remove measure', 'Edit chord diagram', 'Browse scales', 'Inspector context', 'Pitched beat', 'Current staff', 'Current track', 'All tracks', 'Staff 1', 'Measure 1'],
    keys: ['editor.set_note', 'editor.remove_note', 'editor.apply_rhythm', 'editor.make_rest', 'editor.delete_beat', 'editor.remove_measure', 'editor.edit_chord_diagram', 'editor.browse_scales'],
  },
  {
    title: 'mixer',
    mount: () => render(<MixerView score={mixerScore()} selected={0} busy={false} onSelect={vi.fn()} player={null} />),
    sample: ['Mute', 'Selected', 'Bypass'],
    keys: ['mixer.mute'],
  },
  {
    title: 'rig',
    mount: () => render(<Rig />),
    sample: ['Signal chain', 'Copy pedal', 'Paste pedal', 'Hear', 'Apply', 'Save sound', 'Copy pedal: Amp', 'Paste pedal: Amp', 'Duplicate pedal: Amp', 'Move Amp later', 'Enable amp'],
    keys: ['rig.signal_chain', 'rig.copy_pedal'],
  },
  {
    title: 'instrument',
    mount: () => { const score = guitarScore(); return render(<InstrumentView score={score} track={0} staff={0} notes={buildPlaybackPlan(score, 1).notes} />); },
    sample: ['Guitar fretboard', 'Instrument view mode', 'Sounding notes', 'No notes sounding', 'Staff 1 · 6 strings · Capo 2 · fret numbers relative to capo · Open E4 B3 G3 D3 A2 E2'],
    keys: ['instruments.fretboard_guitar', 'instruments.view_mode'],
  },
];

describe('localized surfaces', () => {
  for (const surface of surfaces) {
    describe(surface.title, () => {
      it('offers the English sample in English mode, so the checks below are not vacuous', () => {
        const view = surface.mount();
        const targetEl = (v: ReturnType<typeof render>) => (v.container.childElementCount ? v.container : v.baseElement);
        const found = names(targetEl(view));
        const present = surface.sample.filter(item => found.has(item));
        expect(present.length, `${surface.title}: ${[...found].slice(0, 40).join(' | ')}`).toBeGreaterThan(0);
      });

      for (const lang of ['et', 'de'] as const satisfies readonly SupportedLanguage[]) {
        it(`shows no English button or label name in ${lang}`, () => {
          const english = (() => { const view = surface.mount(); const found = names(view.container); cleanup(); return found; })();
          setLanguagePreference(lang);
          const view = surface.mount();
          const found = names(view.container);
          for (const item of surface.sample) {
            if (!english.has(item)) continue;
            expect(found.has(item), `${lang} ${surface.title} still shows "${item}"`).toBe(false);
          }
          for (const key of surface.keys) {
            const localized = catalogs[lang][key];
            if (localized !== catalogs.en[key]) expect([...found].some(name => name.includes(localized)), `${lang} ${surface.title} lacks "${localized}"`).toBe(true);
          }
        });
      }
    });
  }
});

/** The literals that were once fixed English text in these components. They must stay in the catalogs, not in the source. */
const fixed: Array<[string, RegExp]> = [
  ['src/EditorPanel.tsx', />\s*(Set note|Remove note|Apply rhythm|Make rest|Delete beat|Remove measure|Edit chord diagram|Browse scales)\s*<\/button>/],
  ['src/EditorPanel.tsx', /aria-label="(Active note techniques|Inspector context)"/],
  ['src/EditorPanel.tsx', /'(Empty voice insertion|Full-measure rest|Explicit rest|Pitched beat)'|quarter notes\s/],
  ['src/rig/SoundBrowser.tsx', /Delete “\$\{|>Cancel<\/button>/],
  ['src/rig/BlockStage.tsx', /'(Cabinet model|Microphone output|Amp model)'|>Microphone<|`(Copy|Paste) pedal:|Remove duplicate: \$|Duplicate pedal: \$|`Move \$\{name\}|`Enable \$/],
  ['src/rig/SourcePicker.tsx', /label="Track"/],
  ['src/editor/RangePanel.tsx', />(Current staff|Current track|All tracks)<|>Measures \{|setError\('(Choose|Use)|>String \{|Staff \$\{lane/],
  ['src/editor/ClipboardPanel.tsx', /Phrase at the current beat|Complete bars inserted|Destination (track|staff) for|Copied track \{|Selected phrase ·|`Measures |'Chord diagrams'|'Master tempo automations'/],
  ['src/editor/TechniquePanel.tsx', /Note controls apply to|label="(Bend|Whammy)"/],
  ['src/editor/StructurePanel.tsx', /<h3>Staff \{|>Voice \{/],
  ['src/editor/BarGesturePanel.tsx', /<p>Measure \{/],
  ['src/editor/MeasureTransformPanel.tsx', /<p>Measure \{/],
  ['src/instruments/InstrumentView.tsx', /Drum kit · active percussion|Neck \+ keys|Guitar',bass|fret numbers relative|caption='Sounding|empty='No notes/],
  ['src/editor/AuthorDefaultsPanel.tsx', /Copied this score/],
  ['src/editor/NotationEntryPanel.tsx', /Still entering|outside the MIDI range|cannot be entered here|was not entered|'Removed'|spelling was not changed|could not be found to check/],
  ['src/editor/PartialCapoControls.tsx', /Use a fret from|Choose the strings|Enter the fret of/],
  ['src/editor/BanjoDroneControls.tsx', /needs a 5-string|Use a drone fret|are numbered along the neck/],
  ['src/audio/DrumKitPicker.tsx', /Every drum key|These notations play|is the reference kit|changes \$\{/],
  ['src/workstation/ScoreOverview.tsx', /Playback measure|, measure \$\{/],
  ['src/editor/NoteAudioControls.tsx', /must be a whole number|was not applied|A tied note continues|A bent, whammy/],
  ['src/audio/practice.ts', /Fixed tempo disabled because this score has backing audio/],
  ['src/audio/cabinet-ir.ts', /The impulse response “|is not in this computer's cabinet library/],
  ['src/audio/CabinetResponse.tsx', /Import cabinet impulse response|>Import impulse response…<|>Remove from library<|>Built-in cabinet/],
  ['src/audio/InterpretationPanel.tsx', /aria-label="Track interpretation"|<h3>Interpretation<\/h3>|'Playing style'|Automatic \(from the instrument\)|>Automatic let ring</],
  ['src/protection/PasswordDialogs.tsx', /"Password required"|"Unlock editing"|"Password protection"|>Show passwords<|'Enter the current password\.'/],
  ['src/workspace/ViewDefaultsPanel.tsx', /<summary>Default view<\/summary>|label="Default layout"|label="Default tracks"|>Save default view<\/button>/],
  ['src/workspace/MidiImportDialog.tsx', /aria-label="MIDI file"|'No file chosen'|label="Quantization"|label="Voices per track"|>Guitar and bass as tablature</],
  ['src/workspace/AsciiTabImportDialog.tsx', /<label>ASCII tab<textarea|'Reading the tab…'|'Nothing to import yet\.'/],
  ['src/workspace/DocumentTabs.tsx', /aria-label="Open scores"|`Score \${index\+1} of|'Unsaved score'|aria-label="Finalized"/],
  ['src/workspace/MidiImportDialog.tsx', /\$\{part\.voices\} voices|plural\(part\.notes/],
  ['src/audio/SelectionPlaybackControls.tsx', />(Play from cursor|Play selection|Loop selection)<|<summary>Selected playback|`Measure \$\{/],
  ['src/engraving/BarWidthsPanel.tsx', /<summary>Design: bar widths<\/summary>|Design mode: show bar width handles|>Restore default widths<\/button>/],
  ['src/audio/BackingPanel.tsx', /<h3>Backing audio<\/h3>|'Replace backing'|'Import backing'|>Remove backing<|>Show waveform</],
  ['src/audio/BackingWaveform.tsx', /aria-label="Backing audio waveform"|aria-label="Backing waveform"|>Score follows audio<|>Fit<\/button>/],
  ['src/audio/BackingProcessingControls.tsx', /<summary>Pitch &amp; filter|>Reset<\/button>|label>Filter<select|Changes backing audio only\./],
  ['src/audio/PracticePanel.tsx', /<summary>Practice settings<\/summary>|>Apply practice settings<\/button>/],
  ['src/editor/SectionsPanel.tsx', />Previous section<\/button>|>Next section<\/button>|aria-label="Sections"|No sections yet\./],
  ['src/engraving/EngravingPanel.tsx', />Apply engraving<\/button>|>Reset to source\/default<\/button>|<summary>Staff profiles<\/summary>|<summary>Notation style presets<\/summary>/],
  ['src/engraving/StylePresetsPanel.tsx', />Apply saved style<\/button>|>Force default style<\/button>|<summary>Saved styles<\/summary>/],
  ['src/editor/BarGesturePanel.tsx', /'15ma · two octaves up'|'Straight'|Use positive whole numbers adding up to/],
  ['src/batch/BatchConvertDialog.tsx', /'Looking for scores…'|'Ready to convert\.'|aria-label="Conversion report"|Keep the subfolders in the destination/],
  ['src/editor/CommandPalette.tsx', /'Score editing is unavailable while the score is hidden\.'|aria-label="Command"/],
  ['src/engraving/TrackDisplayControls.tsx', /aria-label="Score display"|<span className="score-tools-caption">Display mode<\/span>|>Fit width<\/button>|>Fit page<\/button>/],
  ['src/workspace/MidiImportDialog.tsx', /`\${chosen\.name} could not be read\.`|plural\(imported\.summary/],
  ['src/App.tsx', /Password protection…|'Working…'|'Unsaved changes'|'Not saved'|'New score'|Save a \.tabplayer project to keep|Click a note to edit it in the inspector|Loading backing timing…|>Retry<|<dt>(Space|Escape|Left \/ Right|Up \/ Down|Digits, then Enter)<|Tie the selected notes to the notes before|The backing timing source changed|Wait for backing timing to load|Enable Score follows audio before|The active reference source changed|FINALIZED_MESSAGE|EDIT_LOCKED_MESSAGE/],
  ['src/audio/BackingWaveform.tsx', /`Measure \$\{|, position \$\{|'Backing audio changed|'The selected score beat is no longer available/],
  ['src/batch/BatchConvertDialog.tsx', /\{kind\.label\}|<td>\{row\.status\}<\/td>|<td>\{row\.detail\}<\/td>|TRUNCATED_NOTE|summarize\(/],
  ['src/engraving/EngravingPanel.tsx', /:'Imported'|'standard'\],\[|preset\.(name|description)/],
  ['src/editor/CommandPalette.tsx', /FINALIZED_MESSAGE/],
  ['src/workspace/MidiImportDialog.tsx', /summary_at_bpm|note\[0\]\.toUpperCase/],
];

describe('fixed English literals', () => {
  for (const [file, pattern] of fixed) {
    it(`${file} has no ${pattern.source.slice(0, 48)}`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(pattern);
    });
  }
});

describe('catalog encoding and wording', () => {
  for (const lang of ['en', 'et', 'de']) {
    it(`${lang}.ts has no byte order mark`, () => {
      const bytes = readFileSync(resolve(process.cwd(), `src/i18n/${lang}.ts`));
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    });
  }

  it('keeps the Estonian terms the review corrected', () => {
    const all = Object.values(catalogs.et).join('\n');
    expect(all).not.toMatch(/medikaator|flazool|Balkeni|\bfermat\b|kolmekümnekahjandik|puhver/i);
    expect(catalogs.et['editor.beaming_thirty_seconds']).toBe('Kolmekümnekahendikud');
    expect(catalogs.et['rig.keep']).toBe('Jäta alles');
  });

  it('keeps the German terms the review corrected', () => {
    expect(catalogs.de['editor.left_hand_tapping']).toBe('Tapping mit der linken Hand');
    expect(catalogs.de['editor.explicit_slur_destination']).toBe('Explizites Bogenziel');
    expect(Object.values(catalogs.de).join('\n')).not.toMatch(/Bindung\b/);
  });
});
