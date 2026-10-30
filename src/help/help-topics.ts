import { version } from '../../package.json';

/** The installed version; a test keeps it equal to the native app and package versions. */
export const appVersion:string=version;

export type HelpTopicId='start'|'editing'|'tracks'|'inspector'|'playback'|'files'|'shortcuts'|'about';
export interface HelpTopic {id:HelpTopicId;title:string;paragraphs:string[]}

export const helpTopics:readonly HelpTopic[]=[
  {id:'start',title:'Getting started',paragraphs:[
    'Open a score with File → Open, start one with File → New, or pick an example or template from the Library.',
    'The score sits in the middle, with the playback controls under the toolbar. Track tools are on the left, the inspector is on the right, and mixing, the instrument view and backing audio are in the bottom dock. View shows or hides each pane.',
    'Press F1 for help about the part of the window you are using. Inside another dialog, close it first.',
  ]},
  {id:'editing',title:'Editing the score',paragraphs:[
    'Click a beat or use the arrow keys to move the blue edit target. Up and Down change the string; type a fret number and press Enter to set the note.',
    'Shift with Left or Right extends a selection for copying, pasting and selection tools. Escape clears it.',
    'Ctrl/Cmd + Shift + P opens the command palette, where you can type commands such as measure 12, fret 5 or tempo 96.',
    'Every edit can be undone with Ctrl/Cmd + Z and redone with Ctrl/Cmd + Shift + Z.',
  ]},
  {id:'tracks',title:'Tracks and sounds',paragraphs:[
    'The Track task lists the instruments. Select one to edit it, and use Selected instrument to change its name, tuning and other settings.',
    'The Sound task chooses the instrument sound and effects; the Backing task aligns an audio recording with the score.',
    'Track changes are recorded in the score history, so Undo reverses them.',
  ]},
  {id:'inspector',title:'The inspector',paragraphs:[
    'Edit holds note, beat, measure, staff and score tools for the edit target or selection, including the capo. Practice holds count-in, metronome and speed-trainer settings for rehearsing a looped passage. Presentation holds the layout, default zoom, notation and default view; the zoom above the score changes the view at once.',
    'Most fields change nothing until you use the panel’s action button, such as Apply or Save.',
  ]},
  {id:'playback',title:'Playback and mixing',paragraphs:[
    'Space plays or pauses. The playback controls under the toolbar play, stop and loop a selected passage, and More playback holds further options. Playback follows the score with a green cursor.',
    'The bottom dock mixes tracks with volume, pan, mute and solo, shows the instrument view, and controls a backing recording.',
  ]},
  {id:'files',title:'Files, import and export',paragraphs:[
    'TabPlayer opens Guitar Pro (.gp, .gpx, .gp3–.gp5) and MusicXML files and saves its own .tabplayer projects. Each score opens in its own tab.',
    'File → Import ASCII tab… reads pasted or loaded text tablature into a new untitled score.',
    'File → Import MIDI… reads a Standard MIDI file (format 0 or 1) into a new untitled score; choose the quantization, tuplets, voices and tablature first.',
    'File → Export score writes PDF, images, MIDI, MusicXML, ASCII tab or audio; Export GP writes a Guitar Pro file.',
    'Export score → Guitar Pro 5 writes a .gp5 file for older programs. It lists what that format leaves out of your score, such as extra staves or tempo changes inside a beat, and asks before saving; Guitar Pro 6 (.gpx) export is not available.',
    'Unsaved changes are kept in recovery and you are asked before a changed score is closed.',
  ]},
  {id:'shortcuts',title:'Keyboard shortcuts',paragraphs:[
    'Ctrl/Cmd + N, O, S: New, Open, Save (add Shift for Save As). Ctrl/Cmd + W closes the score; Ctrl/Cmd + Tab moves between scores.',
    'Ctrl/Cmd + Z undoes and Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y redoes. Space plays or pauses.',
    'Ctrl/Cmd + C, X, V copy, cut and paste music; add Shift to Copy or Cut for all selected tracks.',
    'Ctrl/Cmd + Shift + P opens the command palette. F1 opens this help.',
  ]},
  {id:'about',title:'About and updates',paragraphs:[
    `TabPlayer ${appVersion} for desktop.`,
    'This build has no update service. TabPlayer never downloads or installs updates by itself, and checking for updates never changes your open scores.',
  ]},
];

/** Areas of the window and the topic that explains them; the first match from the focused element wins. */
const contexts:readonly [string,HelpTopicId][]=[
  ['.score-workspace','editing'],['.workstation-left','tracks'],['.workstation-inspector','inspector'],['.workstation-dock','playback'],['.transport','playback'],['.toolbar','files'],['.document-tabs','files'],
];

/** Picks the help topic for the part of the window that had focus. */
export function topicFor(element:Element|null):HelpTopicId {
  for(const [selector,topic] of contexts)if(element?.closest(selector))return topic;
  return 'start';
}

/** What "Check for updates" reports: this build cannot check, so it says so plainly. */
export function updateStatus():string {
  return `You have TabPlayer ${appVersion}. This build has no update service, so it cannot check for newer versions. Install a newer build to update; your scores are not affected.`;
}
