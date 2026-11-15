// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { EditorPanel } from './EditorPanel';
import { music, target } from './editor/fixtures';

let paletteHost: HTMLElement, practiceHost: HTMLElement;
beforeEach(() => {
  paletteHost = document.body.appendChild(document.createElement('aside'));
  practiceHost = document.body.appendChild(document.createElement('div'));
});
afterEach(() => { cleanup(); paletteHost.remove(); practiceHost.remove(); });
function props() {
  return {score:music(),target,string:6,fret:3,noteIndex:null,busy:false,musicSelection:null,paletteHost,practiceHost,
    onSelectNote:vi.fn(),onSelect:vi.fn(),onEdit:vi.fn(),onMusicSelection:vi.fn(),onChord:vi.fn(),onScales:vi.fn(),onOpenLyrics:vi.fn(),onProperties:vi.fn(),onCloseProperties:vi.fn()};
}

it('draws the edition palette into its host and nothing into the inspector: the Selection tab is gone',()=>{
  const input=props();
  const {container}=render(<EditorPanel {...input}/>);
  expect(container).toBeEmptyDOMElement();
  expect(within(paletteHost).getByRole('toolbar',{name:'Editing toolbar'})).toBeInTheDocument();
  expect(screen.queryByRole('tab',{name:'Selection'})).toBeNull();expect(screen.queryByLabelText('Selection context')).toBeNull();expect(screen.queryByRole('button',{name:'Set note'})).toBeNull();
});

it('puts the practice tools in the toolbar pop-up host and keeps the tuner outside the busy fieldset',()=>{
  const input=props();
  const view=render(<EditorPanel {...input} practiceTools={<button>Practice control</button>} tunerTool={<button>Tuner control</button>}/>);
  expect(within(practiceHost).getByRole('button',{name:'Practice control'})).toBeEnabled();
  view.rerender(<EditorPanel {...input} busy practiceTools={<button>Practice control</button>} tunerTool={<button>Tuner control</button>}/>);
  expect(within(practiceHost).getByRole('button',{name:'Practice control'})).toBeDisabled();expect(within(practiceHost).getByRole('button',{name:'Tuner control'})).toBeEnabled();
});

it('palette Lyrics asks for the lyrics editor, and Chords and Scale diagram open their editors',()=>{
  const input=props();
  render(<EditorPanel {...input}/>);
  const toolbar=within(paletteHost);
  fireEvent.click(toolbar.getByRole('button',{name:'Lyrics'}));expect(input.onOpenLyrics).toHaveBeenCalledOnce();
  fireEvent.click(toolbar.getByRole('button',{name:'Chords'}));fireEvent.click(toolbar.getByRole('button',{name:'Scale diagram'}));
  expect(input.onChord).toHaveBeenCalledOnce();expect(input.onScales).toHaveBeenCalledOnce();
  expect(input.onEdit).not.toHaveBeenCalled();
});

it('shows the Properties dialog only while it is requested, and closing it records nothing',()=>{
  const input=props(),view=render(<EditorPanel {...input}/>);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<EditorPanel {...input} properties={{tab:'note',nonce:1}}/>);
  const dialog=screen.getByRole('dialog',{name:'Properties'});expect(dialog).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));expect(input.onCloseProperties).toHaveBeenCalledOnce();expect(input.onEdit).not.toHaveBeenCalled();
});

it('glyph editing toolbar dispatches one undoable edit per duration, dot, rest, tie and technique click with roving keyboard navigation',()=>{
  const input=props();
  render(<EditorPanel {...input}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));
  expect(toolbar.getByRole('button',{name:'Quarter note (1/4)'})).toHaveAttribute('aria-pressed','true');

  fireEvent.click(toolbar.getByRole('button',{name:'Eighth note (1/8)'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setDuration',target,duration:8,dots:0});

  fireEvent.click(toolbar.getByRole('button',{name:'Dotted'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setDuration',target,duration:4,dots:1});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle rest'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setRest',target});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle tie'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'tie'});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle hammer/pull'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteLink',from:{target,string:6},to:{target:{...target,beat:1},string:6},kind:'hammerPull'});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle slide'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{slideOut:1}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle bend'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{bend:{type:1,style:0,points:[{offset:0,value:0},{offset:60,value:4}]}}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle vibrato'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{vibrato:1}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle palm mute'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{palmMute:true}});

  fireEvent.click(toolbar.getByRole('button',{name:'Toggle harmonic'}));
  expect(input.onEdit).toHaveBeenLastCalledWith({type:'setNoteTechniques',target,string:6,patch:{harmonic:{type:1,value:12}}});

  const first=toolbar.getByRole('button',{name:'Whole note (1/1)'});
  first.focus();
  fireEvent.keyDown(first,{key:'ArrowRight'});
  expect(toolbar.getByRole('button',{name:'Half note (1/2)'})).toHaveFocus();
  fireEvent.keyDown(toolbar.getByRole('button',{name:'Half note (1/2)'}),{key:'End'});
  // End lands on the palette's last usable control; without measure settings Tempo is off, so Inverted stem.
  expect(toolbar.getByRole('button',{name:'Inverted stem'})).toHaveFocus();
  // The voices lead the toolbar, as in Guitar Pro's palette, so Home lands on Voice 1.
  fireEvent.keyDown(toolbar.getByRole('button',{name:'Inverted stem'}),{key:'Home'});
  expect(toolbar.getByRole('button',{name:'Voice 1'})).toHaveFocus();
});

it('duration button at current duration and rest toggle on indexed-staff rest record nothing',()=>{
  const input=props();
  render(<EditorPanel {...input}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));

  // Beat 1 starts with Quarter note (4). Clicking Quarter note again records nothing (Finding 2)
  fireEvent.click(toolbar.getByRole('button',{name:'Quarter note (1/4)'}));
  expect(input.onEdit).not.toHaveBeenCalled();

  // Test indexed staff rest toggle
  input.score.tracks[0].staves[0].isPercussion=true;
  input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].isEmpty=false;
  input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes=[];
  // beat 0 is now a rest on percussion/indexed staff
  cleanup();
  render(<EditorPanel {...input}/>);
  const indexedToolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));
  expect(indexedToolbar.getByRole('button',{name:'Toggle rest'})).toHaveAttribute('aria-pressed','true');
  expect(indexedToolbar.getByRole('button',{name:'Toggle rest'})).toBeDisabled();
  fireEvent.click(indexedToolbar.getByRole('button',{name:'Toggle rest'}));
  // Must NOT dispatch setRest on an existing rest on an indexed staff (Finding 2)
  expect(input.onEdit).not.toHaveBeenCalled();
});

it('toggle slide and tie mirror engine preconditions from techniques.ts',()=>{
  const input=props();
  // String 6 has notes on beat 0 and beat 1 in music() fixture.
  // Beat 0: realValue 40 (fret 0 or whatever). Beat 1: change pitch so notes differ!
  const note0=input.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.find(n=>n.string===6)!;
  const note1=input.score.tracks[0].staves[0].bars[0].voices[0].beats[1].notes.find(n=>n.string===6)!;
  note0.fret=3;
  note1.fret=5; // different pitch!

  const view=render(<EditorPanel {...input} target={{...target,beat:0}} string={6}/>);
  const toolbar=within(screen.getByRole('toolbar',{name:'Editing toolbar'}));

  // Toggle tie requires EQUAL pitch according to techniques.ts:38 (Finding 9)
  expect(toolbar.getByRole('button',{name:'Toggle tie'})).toBeDisabled();

  // Make pitch equal: tie should become enabled
  note1.fret=3;
  view.rerender(<EditorPanel {...input} target={{...target,beat:0}} string={6}/>);
  expect(toolbar.getByRole('button',{name:'Toggle tie'})).toBeEnabled();

  // Toggle slide: clear subsequent notes on string 6 so beat 1 has NO next note on string 6!
  // It must be disabled according to techniques.ts:55 (Finding 9)
  for (let b = 2; b < 4; b++) {
    const beat = input.score.tracks[0].staves[0].bars[0].voices[0].beats[b];
    beat.notes = beat.notes.filter(n => n.string !== 6);
  }
  for (let bar = 1; bar < 4; bar++) {
    for (const beat of input.score.tracks[0].staves[0].bars[bar].voices[0].beats) {
      beat.notes = beat.notes.filter(n => n.string !== 6);
    }
  }
  view.rerender(<EditorPanel {...input} target={{...target,beat:1}} string={6}/>);
  expect(toolbar.getByRole('button',{name:'Toggle slide'})).toBeDisabled();
});

it('toolbar keyboard keeps one tab stop always and keeps focus through an edit',()=>{
  const input=props();
  const view=render(<EditorPanel {...input}/>);
  const toolbar=screen.getByRole('toolbar',{name:'Editing toolbar'});

  // Focus a button
  const eighth=within(toolbar).getByRole('button',{name:'Eighth note (1/8)'});
  eighth.focus();
  expect(eighth).toHaveFocus();

  // When busy becomes true during an edit, the button keeps focus (Finding 7)
  view.rerender(<EditorPanel {...input} busy/>);
  expect(eighth).toHaveFocus();
  expect(eighth).toHaveAttribute('aria-disabled','true');

  // Verify there is always at least one tab stop
  const tabStops=toolbar.querySelectorAll<HTMLButtonElement>('button.tp-glyph-btn[tabindex="0"]');
  expect(tabStops.length).toBeGreaterThanOrEqual(1);
});

