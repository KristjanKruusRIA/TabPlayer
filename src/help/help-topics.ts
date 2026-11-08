import { version } from '../../package.json';
import type { MessageKey } from '../i18n';

/** The installed version; a test keeps it equal to the native app and package versions. */
export const appVersion: string = version;

export type HelpTopicId = 'start' | 'editing' | 'tracks' | 'inspector' | 'playback' | 'files' | 'shortcuts' | 'about';
export interface HelpTopic { id: HelpTopicId; title: string; paragraphs: string[] }

export function getHelpTopics(t: (key: MessageKey, params?: Record<string, string | number>) => string): readonly HelpTopic[] {
  return [
    {
      id: 'start',
      title: t('help.topic.start.title'),
      paragraphs: [
        t('help.topic.start.p1'),
        t('help.topic.start.p2'),
        t('help.topic.start.p3'),
      ],
    },
    {
      id: 'editing',
      title: t('help.topic.editing.title'),
      paragraphs: [
        t('help.topic.editing.p1'),
        t('help.topic.editing.p2'),
        t('help.topic.editing.p3'),
        t('help.topic.editing.p4'),
      ],
    },
    {
      id: 'tracks',
      title: t('help.topic.tracks.title'),
      paragraphs: [
        t('help.topic.tracks.p1'),
        t('help.topic.tracks.p2'),
        t('help.topic.tracks.p3'),
      ],
    },
    {
      id: 'inspector',
      title: t('help.topic.inspector.title'),
      paragraphs: [
        t('help.topic.inspector.p1'),
        t('help.topic.inspector.p2'),
        t('help.topic.inspector.p3'),
      ],
    },
    {
      id: 'playback',
      title: t('help.topic.playback.title'),
      paragraphs: [
        t('help.topic.playback.p1'),
        t('help.topic.playback.p2'),
        t('help.topic.playback.p3'),
      ],
    },
    {
      id: 'files',
      title: t('help.topic.files.title'),
      paragraphs: [
        t('help.topic.files.p1'),
        t('help.topic.files.p2'),
        t('help.topic.files.p3'),
        t('help.topic.files.p4'),
        t('help.topic.files.p5'),
        t('help.topic.files.p6'),
        t('help.topic.files.p7'),
      ],
    },
    {
      id: 'shortcuts',
      title: t('help.topic.shortcuts.title'),
      paragraphs: [
        t('help.topic.shortcuts.p1'),
        t('help.topic.shortcuts.p2'),
        t('help.topic.shortcuts.p3'),
        t('help.topic.shortcuts.tie'),
        t('help.topic.shortcuts.p4'),
      ],
    },
    {
      id: 'about',
      title: t('help.topic.about.title'),
      paragraphs: [
        t('help.topic.about.p1', { version: appVersion }),
        t('help.topic.about.p2'),
      ],
    },
  ];
}

export const helpTopics: readonly HelpTopic[] = [
  {
    id: 'start', title: 'Getting started', paragraphs: [
      'Open a score with File → Open, start one with File → New, or pick an example or template from the Library.',
      'The score sits in the middle, with the playback controls in a bar along the bottom. The inspector is on the right: Song holds the score’s settings, Track holds the settings of the selected track and Selection holds the editing tools. Mixing, the instrument view and backing audio are in the bottom dock. View shows or hides each pane.',
      'Press F1 for help about the part of the window you are using. Inside another dialog, close it first.',
    ],
  },
  {
    id: 'editing', title: 'Editing the score', paragraphs: [
      'Click a beat or use the arrow keys to move the blue edit target. Up and Down change the string; type a fret number and press Enter to set the note.',
      'Shift with Left or Right extends a selection for copying, pasting and selection tools. Escape clears it.',
      'Ctrl/Cmd + Shift + P opens the command palette, where you can type commands such as measure 12, fret 5 or tempo 96.',
      'Every edit can be undone with Ctrl/Cmd + Z and redone with Ctrl/Cmd + Shift + Z.',
    ],
  },
  {
    id: 'tracks', title: 'Tracks and sounds', paragraphs: [
      'The Track tab of the inspector holds the settings of the selected track. Select a track in the Tracks list in the bottom dock, or click it in the score. Information moves, duplicates or removes the track, changes its name, color, instrument and tuning, and adds an instrument; tick Keep pitch to retune without changing how the notes sound.',
      'Sounds chooses the instrument sound, the effects and the audio output; Interpretation and MIDI output set how the track plays and where it is sent. Choosing Sound in View shows the full rig for the selected track, and the Backing view in the bottom dock aligns an audio recording with the score.',
      'Track changes are recorded in the score history, so Undo reverses them.',
    ],
  },
  {
    id: 'inspector', title: 'The inspector', paragraphs: [
      'The inspector has three tabs. Song holds the score’s information, its musical notation (layout, default zoom, notation and default view; the zoom above the score changes the view at once) and sound mastering. Track holds the settings of the selected track, described under Tracks and sounds. Selection holds note, beat, measure, staff and score tools for the edit target or selection, including the capo.',
      'Most fields change nothing until you use the panel’s action button, such as Apply or Save.',
      'Count-in, metronome and speed-trainer settings for rehearsing a looped passage are in Practice settings on the toolbar, not in the inspector.',
    ],
  },
  {
    id: 'playback', title: 'Playback and mixing', paragraphs: [
      'Space plays or pauses. The playback bar along the bottom plays, stop and loop a selected passage, and More playback holds further options. Playback follows the score with a green cursor.',
      'The bottom dock mixes tracks with volume, pan, mute and solo, shows the instrument view, and controls a backing recording.',
      'Choosing Mixer in View gives every track a channel strip and adds the master output. Dragging a fader or pan knob is heard as it moves and saved as one change that Undo reverses; Focus is for this session only and is not saved.',
    ],
  },
  {
    id: 'files', title: 'Files, import and export', paragraphs: [
      'TabPlayer opens Guitar Pro (.gp, .gpx, .gp3–.gp5) and MusicXML files and saves its own .tabplayer projects. Each score opens in its own tab.',
      'File → Import ASCII tab… reads pasted or loaded text tablature into a new untitled score.',
      'File → Import MIDI… reads a Standard MIDI file (format 0 or 1) into a new untitled score; choose the quantization, tuplets, voices and tablature first.',
      'File → Batch convert… turns a folder of older scores (and its subfolders) into new .gp files in a separate destination folder. The originals are never changed, and the report lists every file.',
      'File → Export score writes PDF, images, MIDI, MusicXML, ASCII tab or audio; Export GP writes a Guitar Pro file.',
      'Export score → Guitar Pro 5 writes a .gp5 file for older programs. It lists what that format leaves out of your score, such as extra staves or tempo changes inside a beat, and asks before saving; Guitar Pro 6 (.gpx) export is not available.',
      'Unsaved changes are kept in recovery and you are asked before a changed score is closed.',
    ],
  },
  {
    id: 'shortcuts', title: 'Keyboard shortcuts', paragraphs: [
      'Ctrl/Cmd + N, O, S: New, Open, Save (add Shift for Save As). Ctrl/Cmd + W closes the score; Ctrl/Cmd + Tab moves between scores.',
      'Ctrl/Cmd + Z undoes and Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y redoes. Space plays or pauses.',
      'Ctrl/Cmd + C, X, V copy, cut and paste music; add Shift to Copy or Cut for all selected tracks.',
      'Ctrl/Cmd + T ties the selected notes to the notes before them, giving each the earlier fret; Ctrl/Cmd + Shift + T unties them.',
      'Ctrl/Cmd + Shift + P opens the command palette. F1 opens this help.',
    ],
  },
  {
    id: 'about', title: 'About and updates', paragraphs: [
      `TabPlayer ${appVersion} for desktop.`,
      'This build has no update service. TabPlayer never downloads or installs updates by itself, and checking for updates never changes your open scores.',
    ],
  },
];

/** Areas of the window and the topic that explains them; the first match from the focused element wins. */
const contexts: readonly [string, HelpTopicId][] = [
  ['.mixer-view', 'playback'], ['.sound-view', 'tracks'], ['.score-workspace', 'editing'], ['#inspector-panel-track', 'tracks'], ['.workstation-inspector', 'inspector'], ['.workstation-dock', 'playback'], ['.transport', 'playback'], ['.toolbar', 'files'], ['.document-tabs', 'files'],
];

/** Picks the help topic for the part of the window that had focus. */
export function topicFor(element: Element | null): HelpTopicId {
  for (const [selector, topic] of contexts) if (element?.closest(selector)) return topic;
  return 'start';
}

/** What "Check for updates" reports: this build cannot check, so it says so plainly. */
export function updateStatus(t?: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  if (t) return t('help.update_status', { version: appVersion });
  return `You have TabPlayer ${appVersion}. This build has no update service, so it cannot check for newer versions. Install a newer build to update; your scores are not affected.`;
}
