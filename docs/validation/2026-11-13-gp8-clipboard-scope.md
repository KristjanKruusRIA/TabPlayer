# THE-66: Clipboard scope, round 4 (E02, E08, E09, E11)

2026-11-13. Branch `agy/the-66-clipboard-scope`. All four rows stay partial.

## Copy through a sustained beat (E02, E08)

A single-track range whose start or end falls strictly inside a beat of one of its lanes is copied from a detached copy of the score, in which that beat is cut into tied pieces (`src/editor/clipboard-subdivide.ts`). The source score is never touched. The phrase holds exactly the selected time.

- Pieces are plain or single-dotted values from a whole note down to a 64th, fewest pieces, longest first, at most four per side. A tuplet beat keeps its ratio. A cut point with no such exact value (for example 640 ticks into a dotted half) is refused: "...have no exact written length."
- Ties run through the pieces. A tie, slur, slide-out or hammer/pull that left the note now leaves from its last piece; links to a piece outside the range are dropped, so a tail copied from mid-note starts as a plain attack.
- Refused: bent or continued-bend notes, trilled notes, dead notes, whammy beats, beats with an overridden written length, and beats in a free-time measure.
- Cut refuses such a range ("Cut needs a range that starts and ends on beat boundaries..."), because the erase edit works on whole beats.
- The editor still produces attack-aligned ranges only, so this is reachable through the API, not by dragging.

### What each piece carries

| Field | Decision |
| --- | --- |
| Note string, fret, octave, tone, percussion articulation, harmonic type and value, accidental mode | every piece (tie pitch equality) |
| Note dynamics, palm mute, let ring, vibrato, ghost, duration percent | every piece (sound for the whole length) |
| Beat dynamics, vibrato, ottava, crescendo, slashed, wah pedal, tremolo picking | every piece |
| Note accent, staccato, fingering, left-hand tap, ornament, slide-in, show string number | first piece only (attack marks); never on a tail |
| Beat text, lyrics, chord diagram, pick stroke, brush, tap/slap/pop, rasgueado, fermata, fade, timer, automations, barre | first piece only |
| Tie, slur, slide-out, hammer/pull leaving the note | last piece |
| Bend, trill, dead, whammy, overridden length | refused |
| Note `isVisible`, style, ids, indices, link pointers, derived getters | not copied (a note hidden from display cannot be selected as a phrase) |

## Structure at paste (E09)

- A complete navigation-direction group (Fine, Segno, Coda and the jumps that use them) now travels in a multi-track bar clip. At copy time a Segno must be at or before its jump, a Coda or Fine strictly after it, and every jump needs its targets in the clip. Single-track clips still drop directions.
- At paste, a new gesture is refused for a clip target the destination already has, any jump in the clip when the destination already has one, a repeat count above one for a clip with targets or jumps, and a position between a repeat's closing bar and its next ending ("Paste before the repeat, not between its alternate endings.") or inside a multi-bar ending ("Paste before or after the whole alternate ending, not inside it.").
- These refusals live in `pasteGestureProblem` (`clipboard-paste.ts`), called by `DocumentController.edit` before the edit is recorded. `preparePasteMusic`, which replays recorded edits, never calls it, so a project that already holds such a paste builds exactly as before (pinned in `controller.test.ts`).
- Copy-time checks in `readMusicClip` cannot reach a recorded paste: before this round every clip with directions was refused, so no recorded clip carries any.
- Program lanes: the existing guard fires only while track automations are pasted. With the filter off the copied program changes are dropped and the paste proceeds. Two instrument lanes are never merged.

## Not done (E11)

- OS clipboard: nothing reaches the system clipboard and nothing is read from it. Text interchange needs the Tauri clipboard plugin (npm and Cargo dependency, registration, a capability entry) and a paste handler wired to the ASCII-tab parser, which today is a file dialog only.
- MIDI clipboard: needs a registered native clipboard format and a MIDI encoder/decoder for phrases (Rust).

## Tests

`clipboard-subdivide.test.ts`, `clipboard-structure.test.ts`, `clipboard-program-lanes.test.ts`, and three replay/gesture tests in `controller.test.ts`. One assertion changed: `clipboard-source.test.ts` used a lone Segno to expect a direction refusal; a lone Segno is now valid, so it uses a lone Dal Segno jump.
