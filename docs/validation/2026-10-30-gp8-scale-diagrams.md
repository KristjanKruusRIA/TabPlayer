# GP8 parity U05: author scale diagrams (2026-10-30)

GP8 can write marked and fingered scale diagrams into a score. TabPlayer could only browse scales. This slice adds authoring from scratch or from a selection, a chip in the score, and a TabPlayer round trip through GP files. It follows the design in `docs/superpowers/specs/2026-10-24-gp8-scale-diagrams-design.md`. Claude implemented it with an agent, had it reviewed, and ran it on a Windows desktop build. The row stays partial: see Limits.

## Behavior
- **Command:** a new undoable edit, `setScaleDiagram`, puts a diagram on a written beat of a non-drum staff, or removes it.
- **Model:** 3 to 10 strings, 4 to 24 frets, a starting fret, an orientation and marks. Each mark has a shape, colour, up to 3 characters of text and a text colour. String 1 is the lowest string, as for notes, and fret 0 is open. Rust and TypeScript apply the same limits, and refuse characters that XML cannot hold.
- **Authoring:** a "Scale diagram" section in the Scale browser starts blank, from selected notes, or from the scale shown. It has draft editing, Apply, Delete and Discard, one edit each. The grid is one tab stop with arrow keys.
- **In the score:** each diagram is a small chip above its beat. Chips are packed so none covers another, and hovering or focusing one opens the full diagram.
- **Following edits:** diagrams follow their beats through beat, bar and track edits, and `duplicateTrack` copies them.
- **GP files:** diagrams are written to a TabPlayer staff property, and read back when TabPlayer opens the file. A malformed item is skipped with a warning and never blocks opening.
- **While finalized:** the editor is hidden, and native edits are refused.

## Evidence
- **Rust:** 804 tests passed across the merged branch, none failed, including `scale_diagram_protocol` 4, `harmony_protocol` 10 and `protocol` 7. The protocol fixture count is now 76.
- **Frontend:** `tsc` was clean. `src/App.test.tsx` passed 136 of 136 alone at a 60-second timeout, and 587 of 587 passed across the changed areas. Four `src/interchange/gp.test.ts` cases need gitignored fixtures that are not in worktrees; this is not caused by this change.
- **Desktop:** `tests/desktop/parity-scale-diagrams.mjs` passed on a Windows desktop-test build of the merged source. The run:
  - built a 9-string diagram with a tonic and a fingered note, as one native edit, and saw it drawn in the score;
  - undid and redid it, restoring the project and the drawing exactly;
  - deleted an earlier beat, and the diagram followed its beat;
  - exported GP, and every mark was in the file;
  - restarted and opened the export through TabPlayer's own path: every mark came back and was drawn;
  - deleted the diagram as one edit.

  There were no page errors or IPC fallbacks.

## Review
- **First review:** an Opus review found the row could not pass with a dialog-only diagram.
- **Findings and fixes:**
  - **High, fixed:** diagrams were lost or moved to the wrong track by beat, bar and track edits.
  - **High, fixed:** diagrams were drawn mirrored, with string 1 on the wrong side.
  - **High, fixed:** a malformed property refused the whole file.
  - **High, fixed:** a control character could write a GP file that would not reopen.
  - **Medium, fixed:** the driver did not use TabPlayer's loader, and typing a number could destroy marks.
  - **Low, fixed:** a reverted change enabled Apply, and the grid had up to 275 tab stops.
- **Second round:** diagrams on adjacent beats overlapped, which led to the chips. A mark outside the fret window left the grid with no tab stop, and old overlays could linger during a render. All were fixed. The reviewer's verdict was acceptable as partial, not implemented.
- **Desktop run:** the first runs failed in the driver: an idle wait during the modal, a wrapped select matched by label, and a restart that hit the normal recovery prompt.

## Limits
- **Why partial:**
  - PDF, PNG, SVG and print output omit diagrams;
  - GP8 will most likely not draw them, and whether it keeps the property when it re-saves is unverified;
  - the diagram is an overlay above the score, not part of the engraving.
- **No clipboard copy,** MusicXML or ASCII export.
- **String count:** a diagram keeps its strings when the staff's string count changes.
- **No audible playback:** that is U06.
- **No virtualisation:** every diagram mounts its own chip.
