// @vitest-environment jsdom
import '../audio/plugin-test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ContextMenu, isEditableContextTarget, type ContextMenuItem } from './ContextMenu';
import { DocumentTabs } from '../workspace/DocumentTabs';
import { ScoreOverview } from '../workstation/ScoreOverview';
import { WorkspaceApp } from '../workspace/WorkspaceApp';
import { WorkspaceController } from '../workspace/WorkspaceController';
import type { DocumentSnapshot, NativeWorkspaceBridge, WorkspaceSnapshot } from '../workspace/types';
import type { NativeAudioBridge } from '../audio/bridge';
import type { ExportNativeBridge } from '../export/bridge';
import { blankProject, type AssetInfo, type DocumentCandidate, type EditCommand, type Project } from '../project';
import type { NativeBridge } from '../bridge';
import { DEFAULT_PRACTICE } from '../audio/practice-types';

const documentBridges = vi.hoisted(() => new Map<string, NativeBridge>());
vi.mock('../bridge', async original => ({
  ...await original<typeof import('../bridge')>(),
  createDocumentBridge: (id: string) => {
    const bridge = documentBridges.get(id);
    if (!bridge) throw new Error('Missing addressed document bridge');
    return bridge;
  },
}));
vi.mock('../ScoreView', () => ({
  ScoreView: ({ onContextMenu }: { onContextMenu?: (point: { x: number; y: number }) => void }) => (
    <div
      data-testid="mock-score-view"
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.({ x: event.clientX, y: event.clientY });
      }}
    />
  ),
}));
vi.mock('../audio/bridge', () => ({
  createDocumentAudioBridge: vi.fn(
    () =>
      ({
        prepare: vi.fn(async () => {}),
        command: vi.fn(async () => {}),
        setMix: vi.fn(async () => {}),
        devices: vi.fn(async () => []),
        status: vi.fn(async () => null),
        subscribe: vi.fn(async () => () => {}),
        stageBacking: vi.fn(async () => null),
        stageEmbeddedBacking: vi.fn(async () => null),
      }) satisfies NativeAudioBridge,
  ),
}));
vi.mock('../audio/midi-out', async original => ({
  ...await original<typeof import('../audio/midi-out')>(),
  nativeMidiOut: {
    ports: async () => [],
    setDelay: async () => {},
    status: async () => ({ ports: [], sent: 0, dropped: 0, late: 0, maxLateMs: 0 }),
    testLog: async () => [],
  },
}));
vi.mock('../audio/midi-in', async original => ({
  ...await original<typeof import('../audio/midi-in')>(),
  nativeMidiIn: {
    ports: async () => [],
    start: async () => 1,
    configure: async () => {},
    stop: async () => {},
    status: async () => ({ session: 0, state: 'stopped' as const, port: '', message: '', chords: 0, dropped: 0, belowFloor: 0 }),
    subscribe: async () => () => {},
  },
}));
vi.mock('../export/bridge', () => ({
  createDocumentExportBridge: vi.fn(
    () =>
      ({
        exportPdf: vi.fn(async () => null),
        exportMidi: vi.fn(async () => false),
        exportMusicXml: vi.fn(async () => false),
        exportAsciiTab: vi.fn(async () => false),
        exportGp5: vi.fn(async () => false),
        exportSvg: vi.fn(async () => false),
        exportPng: vi.fn(async () => false),
        exportTrackFiles: vi.fn(async () => false),
        exportAudio: vi.fn(async () => null),
        status: vi.fn(async () => null),
        cancel: vi.fn(async () => {}),
      }) satisfies ExportNativeBridge,
  ),
}));
vi.mock('../export/useExportCoordinator', () => ({
  useExportCoordinator: () => ({ busy: false, progress: undefined, run: async () => true, cancel: async () => {} }),
}));
vi.mock('../audio/NativePlaybackController', () => ({
  NativePlaybackController: class {
    state = {
      ready: true,
      playing: false,
      time: 0,
      endTime: 4000,
      measure: 0,
      speed: 100,
      metronome: false,
      error: null,
      practice: { settings: structuredClone(DEFAULT_PRACTICE), phase: 'idle', countInRemaining: 0, completedPasses: 0, effectiveRatio: 1, currentBpm: 120, pulse: null },
      practicePending: false,
      practiceNotice: null,
      loopNotice: null,
      range: null,
      loop: null,
    };
    subscribe = () => () => {};
    getState = () => this.state;
    loadDocument = async () => {};
    beforeScoreChange = () => {};
    destroy = () => {};
    generation = 7;
    cursorPlaybackChoices = () => [];
    selectionPlaybackChoices = () => [];
    playbackOccurrences = () => [];
    playFromCursor = () => {};
    playSelection = () => {};
    loopSelection = () => {};
    backingTimeline = () => null;
    backingScoreSelection = () => ({ points: [], spans: [] });
    setPractice = () => {};
    exportPracticeRatio = () => 1;
    focus = () => null;
    setFocus = async () => {};
    devices = async () => [];
    deviceId = () => null;
    backingDurationMs = () => undefined;
    mix = () => undefined;
  },
}));

const originalViewportWidth = window.innerWidth;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalViewportWidth });
});

it('detects editable text targets so native browser menus keep working in text inputs', () => {
  const textInput = document.createElement('input');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const textarea = document.createElement('textarea');
  const button = document.createElement('button');
  const editableDiv = document.createElement('div');
  editableDiv.setAttribute('contenteditable', 'true');
  expect(isEditableContextTarget(textInput)).toBe(true);
  expect(isEditableContextTarget(textarea)).toBe(true);
  expect(isEditableContextTarget(editableDiv)).toBe(true);
  expect(isEditableContextTarget(checkbox)).toBe(false);
  expect(isEditableContextTarget(button)).toBe(false);
  expect(isEditableContextTarget(null)).toBe(false);
});

it('renders ContextMenu items, shortcuts, submenus, keyboard navigation, and outside dismissal', () => {
  const onCopy = vi.fn();
  const onInsert = vi.fn();
  const onClose = vi.fn();
  const items: ContextMenuItem[] = [
    { kind: 'item', id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', onSelect: onCopy },
    { kind: 'item', id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: true, onSelect: vi.fn() },
    { kind: 'separator', id: 'sep' },
    {
      kind: 'submenu',
      id: 'bar',
      label: 'Bar',
      items: [{ kind: 'item', id: 'insert', label: 'Insert after', onSelect: onInsert }],
    },
  ];
  render(<ContextMenu x={24} y={32} label="Score actions" items={items} onClose={onClose} />);
  const root = screen.getByRole('menu', { name: 'Score actions' });
  expect(within(root).getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
  expect(within(root).getByRole('menuitem', { name: 'Paste' })).toBeDisabled();
  expect(within(root).getByRole('separator')).toBeInTheDocument();

  const barTrigger = within(root).getByRole('menuitem', { name: 'Bar' });
  barTrigger.focus();
  fireEvent.keyDown(root, { key: 'ArrowRight' });
  const sub = screen.getByRole('menu', { name: 'Bar' });
  const insertItem = within(sub).getByRole('menuitem', { name: 'Insert after' });
  expect(document.activeElement).toBe(insertItem);
  fireEvent.click(insertItem);
  expect(onInsert).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(root, { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByRole('menu', { name: 'Bar' }), { key: 'ArrowLeft' });
  expect(screen.queryByRole('menu', { name: 'Bar' })).toBeNull();
  expect(document.activeElement).toBe(barTrigger);

  fireEvent.mouseDown(document.body);
  expect(onClose).toHaveBeenCalledTimes(2);
});

it('opens a tab context menu on DocumentTabs right-click with New, Close, and Close all actions', () => {
  const onNew = vi.fn();
  const onClose = vi.fn();
  const onCloseAll = vi.fn();
  render(
    <DocumentTabs
      tabs={[
        { id: 'doc-1', title: 'First', path: null, dirty: false, locked: false },
        { id: 'doc-2', title: 'Second', path: null, dirty: true, locked: false },
      ]}
      activeId="doc-1"
      disabled={false}
      onActivate={vi.fn()}
      onClose={onClose}
      onCloseAll={onCloseAll}
      onNew={onNew}
    />,
  );
  const secondTab = screen.getByRole('tab', { name: /Second/ }).closest('.document-tab-item')!;
  fireEvent.contextMenu(secondTab, { clientX: 80, clientY: 20 });
  const menu = screen.getByRole('menu', { name: 'Tab actions' });
  expect(within(menu).getByRole('menuitem', { name: 'New score' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Close score' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Close all scores' })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close score' }));
  expect(onClose).toHaveBeenCalledWith('doc-2');
});

it('routes right-click in ScoreOverview to track vs bar callbacks', () => {
  const onTrackContextMenu = vi.fn();
  const onBarContextMenu = vi.fn();
  render(
    <ScoreOverview
      model={{
        barCount: 2,
        sections: [],
        tracks: [
          { index: 0, name: 'Lead', cells: ['music', 'empty'] },
          { index: 1, name: 'Bass', cells: ['music', 'music'] },
        ],
      }}
      target={{ track: 0, staff: 0, bar: 0, voice: 0, beat: 0 }}
      playbackBar={null}
      onSelect={vi.fn()}
      onExit={vi.fn()}
      onTrackContextMenu={onTrackContextMenu}
      onBarContextMenu={onBarContextMenu}
    />,
  );
  const trackRow = screen.getByText('Bass').closest('.score-overview-track')!;
  fireEvent.contextMenu(trackRow, { clientX: 40, clientY: 50 });
  expect(onTrackContextMenu).toHaveBeenCalledWith(1, { x: 40, y: 50 });

  const cell = document.querySelector('[data-overview-track="1"][data-overview-bar="1"]')!;
  fireEvent.contextMenu(cell, { clientX: 120, clientY: 60 });
  expect(onBarContextMenu).toHaveBeenCalledWith(1, 1, { x: 120, y: 60 });

  const header = screen.getByText('2').closest('.score-overview-bar-label')!;
  fireEvent.contextMenu(header, { clientX: 140, clientY: 10 });
  expect(onBarContextMenu).toHaveBeenCalledWith(0, 1, { x: 140, y: 10 });
});

let workspace: WorkspaceController;
const activeController = () => workspace.getState().documents.find(entry => entry.id === workspace.getState().active.documentId)!.controller;
const twoTracks = (): Project => ({ ...blankProject(), edits: [{ type: 'addTrack', name: 'Bass', tuning: [43, 38, 33, 28], program: 33 }] });

async function setupWorkspace(initial = blankProject()) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  documentBridges.clear();
  let next = 0, activation = 0;
  const active = { documentId: '', activationId: '' };
  const records = new Map<string, DocumentSnapshot>(), staged = new Map<string, DocumentCandidate>();
  const add = (project: Project, path: string | null = null) => {
    const documentId = `ctx-doc-${++next}`;
    let edits: EditCommand[] = [...project.edits], cursor = edits.length, revision = 0;
    const assets: Record<string, AssetInfo> = { ...project.assets };
    const record = (): DocumentSnapshot => ({
      documentId,
      revision,
      snapshot: { project: { ...project, assets, edits: edits.slice(0, cursor) }, canUndo: cursor > 0, canRedo: cursor < edits.length, redoEdit: edits[cursor] ?? null, dirty: cursor > 0, path },
    });
    const update = () => {
      revision++;
      const value = record();
      records.set(documentId, value);
      return value;
    };
    const bridge: NativeBridge = {
      documentId,
      snapshot: async () => record(),
      cancelAsset: vi.fn(async () => true),
      readBackingAsset: async () => { throw new Error('unused'); },
      applyEdit: async command => { edits = edits.slice(0, cursor); edits.push(command); cursor++; return update(); },
      undo: async () => { cursor--; return update(); },
      redo: async () => { cursor++; return update(); },
      setLock: vi.fn() as never,
      saveProject: async () => null,
      exportGp: vi.fn(async () => false),
      askUnsaved: vi.fn(async () => 'discard' as const),
      confirmExport: vi.fn(async () => false),
    };
    records.set(documentId, record());
    documentBridges.set(documentId, bridge);
    return documentId;
  };
  const snapshot = (): WorkspaceSnapshot => ({ documents: [...records.values()], active: { ...active } });
  const activate = (id: string) => {
    if (id !== active.documentId) {
      active.documentId = id;
      active.activationId = `ctx-act-${++activation}`;
    }
    return snapshot();
  };
  activate(add(initial));
  const bridge: NativeWorkspaceBridge = {
    snapshot: async () => snapshot(),
    readDocument: async () => null,
    createBlankDocument: async () => { const token = `new-${++next}`; const c = { project: blankProject(), path: null, token }; staged.set(token, c); return c; },
    cancelDocument: async token => staged.delete(token),
    addDocument: async token => { const c = staged.get(token)!; staged.delete(token); return activate(add(c.project, c.path)); },
    activateDocument: async id => activate(id),
    closeDocuments: async decisions => {
      for (const decision of decisions) records.delete(decision.documentId);
      if (!records.size) add(blankProject());
      return records.has(active.documentId) ? snapshot() : activate([...records.keys()][0]);
    },
  };
  workspace = await WorkspaceController.create(bridge);
  render(<WorkspaceApp workspace={workspace} />);
  return activeController();
}

it('shows distinct context menus for Score, Track, and Measure in App and suppresses generic browser menus', async () => {
  await setupWorkspace(twoTracks());

  // 1. Score right-click -> Cut, Copy, Paste, All-track Cut/Copy, Special Paste, Bar/Note/Effects submenus
  fireEvent.contextMenu(screen.getByTestId('mock-score-view'), { clientX: 200, clientY: 200 });
  const scoreMenu = screen.getByRole('menu', { name: 'Score actions' });
  expect(within(scoreMenu).getByRole('menuitem', { name: 'Cut' })).toBeInTheDocument();
  expect(within(scoreMenu).getByRole('menuitem', { name: 'All-track copy' })).toBeInTheDocument();
  expect(within(scoreMenu).getByRole('menuitem', { name: 'Paste' })).toBeDisabled();
  fireEvent.mouseEnter(within(scoreMenu).getByRole('menuitem', { name: 'Bar' }));
  const barSub = screen.getByRole('menu', { name: 'Bar' });
  fireEvent.click(within(barSub).getByRole('menuitem', { name: 'Insert after' }));
  await waitFor(() => expect(activeController().getState().snapshot.project.edits.at(-1)).toMatchObject({ type: 'insertMeasures', count: 1 }));

  // 2. Track right-click in Overview -> Remove/Duplicate/Move for the clicked track
  const bassRow = screen.getByRole('button', { name: 'Select track Bass' }).closest('.score-overview-track')!;
  fireEvent.contextMenu(bassRow, { clientX: 50, clientY: 500 });
  const trackMenu = screen.getByRole('menu', { name: 'Track actions' });
  expect(within(trackMenu).getByRole('menuitem', { name: 'Add track…' })).toBeInTheDocument();
  expect(within(trackMenu).getByRole('menuitem', { name: 'Remove Bass' })).toBeEnabled();
  expect(within(trackMenu).getByRole('menuitem', { name: 'Duplicate Bass' })).toBeEnabled();
  expect(within(trackMenu).getByRole('menuitem', { name: 'Move Bass up' })).toBeEnabled();
  expect(within(trackMenu).getByRole('menuitem', { name: 'Move Bass down' })).toBeDisabled();
  fireEvent.click(within(trackMenu).getByRole('menuitem', { name: 'Duplicate Bass' }));
  await waitFor(() => expect(activeController().getState().snapshot.project.edits.at(-1)).toEqual({ type: 'duplicateTrack', track: 1 }));

  // 3. Measure right-click in Overview -> Go to measure / Bar properties / Insert / Remove
  const measureCell = document.querySelector('[data-overview-track="0"][data-overview-bar="0"]')!;
  fireEvent.contextMenu(measureCell, { clientX: 250, clientY: 500 });
  const measureMenu = screen.getByRole('menu', { name: 'Measure actions' });
  expect(within(measureMenu).getByRole('menuitem', { name: 'Go to measure 1' })).toBeInTheDocument();
  fireEvent.keyDown(measureMenu, { key: 'Escape' });

  // 4. Chrome suppresses default browser context menu without opening a custom menu; text input keeps browser menu
  const chrome = document.querySelector('.gp-toolbar')!;
  const chromeEvent = createEvent.contextMenu(chrome, { clientX: 10, clientY: 10 });
  fireEvent(chrome, chromeEvent);
  expect(chromeEvent.defaultPrevented).toBe(true);
  expect(screen.queryByRole('menu')).toBeNull();

  const trackInput = screen.getByLabelText('Track name', { selector: 'input' });
  const inputEvent = createEvent.contextMenu(trackInput, { clientX: 10, clientY: 10 });
  fireEvent(trackInput, inputEvent);
  expect(inputEvent.defaultPrevented).toBe(false);
}, 30000);
