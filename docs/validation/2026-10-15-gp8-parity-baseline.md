# Guitar Pro 8.1.5.31 desktop feature audit

Audited 2026-10-15. Baseline **TabPlayer 0.2.0, `7fc41c773a1b016d7249ceb98ab7929fcca1ce8f`**. Read-only audit; no product changes, app launch, rebuild, new test run or Git mutation. Concurrent work is outside this baseline.

**258 enumerated requirements:** 51 implemented, 53 partial, 146 missing, 8 unverified. Counts are not a parity percentage. Full Guitar Pro parity is **not established**.

## Method and version boundary

The [official GP8 manual landing page](https://support.guitar-pro.com/hc/en-us/articles/5018404823069-GP8-Guitar-Pro-8-User-Guide) links the [334-page public PDF](https://static.guitar-pro.com/gp8/manual/Guitar-Pro-8-user-guide.pdf). Printed page N is PDF page N+6. The complete public online manual index (151 pages), cited sections and relevant FAQ/release notes were inspected. SVG export and Jianpu appeared in 8.1 and therefore belong to 8.1.5.31; the cited capability families are cross-checked to the GP8 baseline. [Official release notes](https://www.guitar-pro.com/c/10-guitar-pro-new-features) identify the 8.1 additions and 8.1.5 fixes. Requirement catalog: `gp8-desktop-parity-v1`, schema version 1.

Source links below are worktree paths for convenience, with line numbers/hash snapshots in JSON pinned to the released baseline. Code graph tools were unavailable. Existing source assertions were read; broad test names, green logs and old scope checkmarks were not treated as behavioral parity evidence. No vendor assets/private music are included in these deliverables. The reference PDF/text cache is ignored local audit material.

Statuses: **implemented** supports the specific narrow behavior with implementation/UI and meaningful existing assertions; **partial** retains an explicit missing subcapability/fidelity path; **missing** has no exposed baseline path; **unverified** needs actual evidence. No status certifies original GP runtime equivalence.

## Highest priority hard gaps

1. Full notation/authoring model: non-tab pitched/percussion entry, nested tuplets, directions/fermatas, lyrics, additional gestures, audio note fine settings and editable automation.
2. Range editing/clipboard and track/instrument workflows: multivoice selection, cross-document copy/cut/special paste, string-count changes/refingering, partial capo and structured chord/scale tools.
3. Interchange fidelity: MusicXML/MIDI/ASCII/PTB/TEF imports; legacy GP/XML/ASCII/PNG/SVG/compressed audio exports; known GPIF field losses; original target-runtime acceptance.
4. Practice/audio depth: partial loops, arbitrary/fixed/progressive speed, count-in/visual metronome, waveform sync/pitch/filter tools, drum/master mixing, preset library and missing FX families.
5. Desktop/engraving/integrations: tabs/templates/recovery/library, stylesheet/design/page modes, print dialog/physical output, MIDI I/O/Line-In/tuner/Fretlight/mySongBook.

## Complete requirements matrix

Each row links a specific official manual page; `pp.` refers to its printed PDF pages. Source/test keys resolve in the evidence register. For implemented rows, listed acceptance states what must be rerun for a parity release; for all others it states the remaining closure check.

### Document and desktop workflow

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|W01|Create a new blank score|implemented|initial,app; tests enginetest|Creates initial guitar score and replaces document transactionally.|[manual](https://www.guitar-pro.com/docs/gp8/score/project/new-file), pp.60–66|
|W02|Open GP-family scores|partial|nativeio,import; tests advanceddesktop|GP3/4/5/GPX/GP accepted; original GTP absent from filter and exhaustive version coverage absent.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.40–43,66|
|W03|Save and Save As|implemented|nativewrite,controller; tests filetest|Native project atomic saves preserve immutable input and supported edits.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66|
|W04|Undo and redo document edits|implemented|controller,session; tests filetest,advanceddesktop|History covers finite commands and sound/backing/layout settings.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/main-screen), pp.44–50|
|W05|Multiple open documents and tab management|missing|app,controller|One controller and document; no tabs/Close/Close All/switching state.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/main-screen), pp.44–50|
|W06|Factory templates and save personal templates|missing|app,cmd|One fixed starter score; no template chooser or repository.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.40–43,60–66|
|W07|Recent files with pinning|missing|app,session|No recent-file history or pin state.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/welcome-page), pp.26,40–43|
|W08|Local score browser/search/index|missing|app|Only native Open picker; no indexed local library.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/welcome-page), pp.40–43|
|W09|Bundled example scores|missing|app|No in-app example catalog; test fixtures are not product examples.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/welcome-page), pp.40–43|
|W10|Autosave and crash/session recovery|missing|session,nativewrite|Explicit save history does not provide timed backup or restore after crash.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/general), pp.300–302|
|W11|Restore last open session|missing|app,session|No persisted open-document/session list.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/general), pp.300–302|
|W12|Drag-and-drop score intake|missing|app,nativeio|No drop event or native drop-to-open flow.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66|
|W13|OS file association/open-at-launch|unverified|nativeio,app|Open picker works; no reviewed argv/second-instance association flow or installer receipt for score types.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66|
|W14|Reveal current file folder|missing|app|No reveal-in-file-manager action.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66|
|W15|Finalize/unfinalize a document|missing|cmd,session|No finalized/read-only document state.|[manual](https://www.guitar-pro.com/docs/gp8/tools/protection), pp.259|
|W16|Password lock editing|missing|cmd,session|No password/edit-permission workflow.|[manual](https://www.guitar-pro.com/docs/gp8/tools/protection), pp.259|
|W17|Password lock opening|missing|cmd,session|No encrypted/password-open workflow.|[manual](https://www.guitar-pro.com/docs/gp8/tools/protection), pp.259|
|W18|Command palette with typed musical commands|missing|app,keys|No searchable/typed command dispatcher UI.|[manual](https://www.guitar-pro.com/docs/gp8/tools/command-palette), pp.263–284|
|W19|Keyboard workflow and configurable input preferences|partial|keys; tests editortest|Arrows/digits/Enter only; no complete file/history/notation/practice shortcut set.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/shortcuts), pp.324–328|
|W20|Application language localization|missing|app|UI strings are English; no locale selection or translation resources.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/interface), pp.303–304|
|W21|Application updates/help/manual access|missing|app|No help/manual/update menu; shipping artifacts are separately built.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/help), pp.36–38|

### Score, tracks, instruments and tuning

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|S01|Edit complete song metadata|partial|cmd,engine; tests enginetest|Only title/artist/tempo writable; subtitle/album/lyricist/composer/copyright/transcriber/notices/instructions absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/project/score-setup/information), pp.60–66|
|S02|Add/remove and rename tracks|implemented|initial,track,structure; tests structuretest|String-tuned tracks can be added/removed and full/short names changed.|[manual](https://www.guitar-pro.com/docs/gp8/score/project/new-track), pp.67–69|
|S03|Reorder, duplicate and recolor tracks|missing|cmd,track|No move/duplicate/color commands.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-information), pp.67–69|
|S04|Instrument wizard for strings, orchestra, percussion and MIDI|partial|initial,track|New track always has string tuning; program chooser is not full instrument taxonomy.|[manual](https://www.guitar-pro.com/docs/gp8/score/project/new-track), pp.67–69|
|S05|All General MIDI program choices|implemented|track,structure; tests structuretest|All 128 program values selectable; independent sound quality is a separate row.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-sound), pp.67–69,180–193|
|S06|Create/edit pitched non-tab notes|missing|editor,engine|Only string/fret commands; no pitch/octave note command for keyboard/orchestra.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|S07|Create/edit percussion notes and articulations|missing|editor,initial|Set note disabled for percussion; imported kit playback alone is supported.|[manual](https://www.guitar-pro.com/docs/gp8/score/drums), pp.97–100|
|S08|Grand staff and independent staves|partial|structure,editor; tests structuretest|Can add stringed staves and set clefs; no proper keyboard/grand-staff authoring flow.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-notation), pp.67–69,76–78|
|S09|One to four independent voices|implemented|structure,editor; tests structuretest,replaytest|Four aligned voices with independent beats and voice selection.|[manual](https://www.guitar-pro.com/docs/gp8/score/voices), pp.76–78|
|S10|Simultaneous multivoice editing and voice colors|missing|cmd,editor,view|Editing targets one voice; no multivoice selection/mode or color configuration.|[manual](https://www.guitar-pro.com/docs/gp8/score/voices), pp.76–78|
|S11|Move/copy/swap voices and notes|partial|structure; tests structuretest|Copy a same-staff bar range exists; move/swap/note reassignment absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/note-score-assistants), pp.96|
|S12|Custom note-name tuning input|implemented|tunings,track,structure; tests tunetest|Named pitches parsed and saved; existing staff string count is fixed.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.70,90–92|
|S13|Full tuning library across string instruments|partial|tunings|25 guitar/bass presets; banjo/ukulele/mandolin/bowed-string/shamisen catalog absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.70,90–92|
|S14|Change existing instrument string count|missing|structure|validateStaff rejects string-count change.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.70,90–92|
|S15|User tuning library and display labels|missing|cmd,tunings|Custom input has no save/name/manage library or score label.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S16|Tuning and individual-string audition|missing|track,sound|No audition action in tuning controls.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S17|Whole-instrument capo|implemented|structure; tests structuretest,instrumenttest|Integer staff capo affects model pitch and viewer readout.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S18|Partial capo by string|missing|cmd,structure|No per-string capo model/control.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S19|Keep or adjust fingering on retune/capo change|partial|structure|Keeps frets and changes pitch; pitch-preserving re-fingering option absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S20|Banjo short drone configuration|missing|cmd,structure|No banjo drone/fret offset authoring.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-tuning), pp.90–92|
|S21|Sounding/display transposition and concert pitch|partial|structure; tests structuretest|Numeric staff sounding/display offsets exist; global concert-pitch/automatic key workflow absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/tonality-transposition), pp.62–66,70|
|S22|Playing style pick/fingers/picking/slap|missing|cmd,settings|Voice inference/override does not expose track interpretation style.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-interpretation), pp.180–193|
|S23|Track interpretation intensity and automatic articulation|missing|cmd,settings|No palm-mute intensity/strong-beat accent/automatic let-ring/brush controls.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-interpretation), pp.180–193|
|S24|Stringed-vs-piano sustain interpretation|partial|plan,settings|Imported engine semantics may remain; no editable interpretation toggle.|[manual](https://www.guitar-pro.com/docs/gp8/score/track-settings/track-interpretation), pp.180–193|

### Selection and score editing

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|E01|Click notes/beats and navigate score|implemented|view,keys,editor; tests editortest|Beat/note mouse selection and arrow navigation choose string/staff/voice/beat.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/click), pp.51–54,90–91|
|E02|Range, partial-beat and multi-track selections|missing|app,cmd|Document edits target one beat; export range is not editable range selection.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/click), pp.51–54,90–91|
|E03|Select all/bar/track and triple-click selection|missing|view,keys|No range selection callbacks or select-all/bar/track commands.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/click), pp.27–34,90–91|
|E04|Create/edit/delete fretted notes and chords|implemented|engine,editor; tests enginetest|setNote per string can form chords; removeNote/rest supported.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|E05|Standard notation mouse/keyboard pitch entry|missing|view,keys,cmd|Click selects existing notes; no staff-position pitch insertion.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|E06|Insert/delete beats|implemented|engine,editor; tests enginetest|Finite insert/delete commands preserve selection/relationships.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|E07|Insert/delete bars at cursor or range|partial|engine,editor; tests enginetest|Append one global measure and remove one exist; arbitrary insert/range batch absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/bars), pp.71–73|
|E08|Single-track copy/cut/paste|missing|cmd,keys|No score clipboard command or UI.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste), pp.88–89|
|E09|Multitrack copy/cut/paste with bar structure|missing|cmd,keys|No clipboard schema or global structure paste.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste), pp.88–89|
|E10|Special paste with repeated paste and content filters|missing|cmd|No repeat-paste or chord/text/timer/automation/section filter.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste), pp.88–89|
|E11|Cross-document/OS clipboard musical interchange|missing|app,cmd|No multi-document clipboard or MIDI clipboard generation/intake.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste), pp.88–89|
|E12|Move notes between strings preserving pitch|missing|cmd,engine|Re-fretting manual only; no pitch-preserving string shift.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|E13|Transpose selected notes by semitone/octave|missing|cmd,engine|Fret replacement is not selection pitch-shift command.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|E14|Automatic finger positioning|missing|cmd|No fingering optimization assistant.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/note-score-assistants), pp.96|
|E15|Bar arranger and bar-duration checker|partial|engine,notation|Overflow rejection exists; no underfull report/fill/split/rebalance assistant.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/note-score-assistants), pp.96|
|E16|Range let-ring and palm-mute assistants|missing|cmd,tech|Only per-note flags; no string/range batch assistant.|[manual](https://www.guitar-pro.com/docs/gp8/score/assistant/note-score-assistants), pp.96|
|E17|Edit/play preview while authoring|missing|engine,player|Edits stop/reset transport; no note-entry audible preview toggle.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/note-input), pp.79–87|
|E18|Find/go to section or musical position|partial|editor,transport|Numeric bar/beat selectors exist; no section navigator/global timeline.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/navigate), pp.51–54,74–75|
|E19|Context menus and direct symbol editing|partial|view,editor|Notes select inspector; no title/chord/tempo/clef double-click editor or context palette.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/click), pp.90–91|
|E20|Lyrics with syllables, verses and beat alignment|missing|cmd,editor|Beat free text exists; no lyric tracks/5 lines/syllable/verse assignment.|[manual](https://www.guitar-pro.com/docs/gp8/score/lyrics), pp.131–132|

### Notation and rhythm

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|N01|Standard, tablature and combined notation|implemented|view,structure; tests pdftest,structuretest|Score/Tab/ScoreTab profiles and per-staff visibility exist.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/notations), pp.55–58,67–69|
|N02|Rhythmic/slash notation on strings, standard and drums|missing|cmd,view|No slash/rhythm profile or per-beat slash command.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/notations), pp.28–34,129–130|
|N03|Numbered notation (Jianpu, introduced in 8.1)|missing|cmd,view|No Jianpu display/editor profile.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/jianpu), pp.81–83|
|N04|Durations, rests, dotted and double-dotted notes|implemented|engine,notation; tests notationtest|Whole through 1/256 and long values, rests, 0–3 dots implemented.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N05|Single-level custom tuplets and polyrhythms|implemented|notation,editor; tests notationtest|Numerator/denominator per beat and independent voices implemented.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/tuplet), pp.84–87,106–111|
|N06|Nested tuplets with separate outer/inner ratios|missing|cmd,notation|Only one numerator/denominator pair; no nested grouping model/commands.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/tuplet), pp.22,84–87|
|N07|Grace notes before/on beat|implemented|notation,editor; tests notationtest,plantest|Public grace-type field exposed; plan preserves grace timing identity.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/ornements-expressive-effects/grace-notes), pp.112–127|
|N08|Ties and explicit break incoming/outgoing|implemented|links,techui; tests techtest,replaytest|Same-pitch next-string ties and explicit break commands repair chains.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N09|Multiple ties across chord/voices|missing|cmd,links|Individual tie editing only; no all-notes/all-voices tie action.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N10|Clef changes and octave clefs|partial|notation,structure; tests notationtest|Four clef enums editable; octave clef/ottava regions absent.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N11|Key signatures and major/minor|implemented|notation; tests notationtest|Per-bar -7 to +7 and mode editable.|[manual](https://www.guitar-pro.com/docs/gp8/score/project/score-setup/keys), pp.62–66,101–105|
|N12|Meter changes including pickup and free time|implemented|notation; tests notationtest|Numerator/power-of-two denominator/pickup/free-time set with overflow validation.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.71–73,101–105|
|N13|Common/cut time display and custom beaming groups|missing|notation,cmd|Meter command forces timeSignatureCommon=false; beam groups not writable.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N14|Triplet feel/swing interpretation|missing|cmd,notation|Imported field may play; no authoring triplet-feel control.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N15|Start/end repeats and alternate endings|implemented|notation; tests notationtest,plantest|Repeat count/start/endings flags editable; plan unfolds played occurrences.|[manual](https://www.guitar-pro.com/docs/gp8/score/directions), pp.162–168|
|N16|One-bar and two-bar repeat symbols|missing|cmd,notation|No simile/repeat-bar command.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N17|D.C./D.S./coda/segno/fine directions|missing|cmd,notation|No authored direction targets/jumps.|[manual](https://www.guitar-pro.com/docs/gp8/score/directions), pp.162–168|
|N18|Fermatas and per-beat time extension|missing|cmd,notation|No fermata length/type command or UI.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N19|Double bar lines and final bar controls|missing|cmd,notation|No explicit barline type command.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N20|Octave regions (8va/8vb/15ma/15mb)|missing|cmd,notation|Whole-staff display offset does not provide bounded ottava regions.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), pp.101–105|
|N21|Accidental spelling, double accidentals and enharmonics|missing|cmd,tech|Fret pitches render automatically; no accidental spelling/respell command.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N22|Courtesy accidentals|missing|cmd,tech|No cautionary accidental authoring field.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.28–34,106–111|
|N23|Dynamics ppp through fff|partial|tech; tests techtest,coverage|Native per-note dynamics exist; GP writer loses tested per-note value.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), pp.106–111|
|N24|Crescendo/decrescendo hairpins|missing|cmd,tech|No hairpin span/type command.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/accents-staccato), pp.106–111|
|N25|Stem direction and forced/secondary beam grouping|missing|cmd,notation|Automatic renderer only; no stem/beaming/tuplet-group controls.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/notation), pp.129–130|
|N26|Extended barre/semi-barre and string-number indications|missing|cmd,tech|No bounded barre or explicit string-number display controls.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/notation), pp.129–130|
|N27|Beat text and named sections|implemented|notation; tests notationtest|Plain beat text and one section marker/text per bar editable.|[manual](https://www.guitar-pro.com/docs/gp8/score/sections), pp.74–75,129–130|
|N28|Timers/chronos printed in score|missing|cmd,notation|Transport time output is not a score timer annotation.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/notation), pp.129–130|
|N29|Multirests and hiding empty/unneeded rests|missing|cmd,view|No multirest or unnecessary-rest layout command.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/notation), pp.133–161|

### Playing techniques and articulations

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|T01|Let ring|implemented|tech,techui; tests techtest,rendertest|Selected-note flag, replay and sustain renderer path exist.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/let-ring), pp.112–127|
|T02|Palm mute|implemented|tech,techui; tests techtest,rendertest|Selected-note flag and shortened native envelope exist.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/palm-mute), pp.112–127|
|T03|Dead and ghost notes|implemented|tech; tests techtest,rendertest|Selected flags affect native articulation/envelope and notation.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/dead-ghost-notes), pp.112–127|
|T04|Accent, heavy accent and staccato|implemented|tech; tests techtest,replaytest|Enums and staccato produce authored dynamics/duration effects.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/accents-staccato), pp.112–127|
|T05|Automatic picking direction and patterned gestures|missing|cmd,beattech|No alternate/economy-picking or repeating gesture/fingering patterns.|[manual](https://www.guitar-pro.com/docs/gp8/tools/command-palette), pp.271–279|
|T06|Hammer-on/pull-off and legato links|implemented|links,techui; tests techtest,replaytest,rendertest|Validated link endpoints and native legato path exist.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/legato), pp.112–127|
|T07|Explicit phrase slurs|partial|links,pdf,gpwrite; tests replaytest,pdftest,selecttest|Native/JSON/PDF keep explicit phrase; GP writer omits nonadjacent cross-string phrase.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/legato), pp.112–127|
|T08|Shift/legato slides and slide-in/out variants|implemented|tech; tests techtest,replaytest,plantest|All public slide enums exposed; linked targets validated.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/slides), pp.112–127|
|T09|Per-note bend/prebend/release curves|partial|tech,techui; tests techtest,coverage,rendertest|Native curves independent; GP export simplifies interior points/styles.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/bends), pp.112–127|
|T10|Whammy-bar curves and quarter tones|partial|beattech,techui; tests techtest,coverage|Native whammy curves allow quarter-tone values; GP writer changes type/style/interior points.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/bends), pp.28–34,112–127|
|T11|Slight/wide left-hand vibrato|implemented|tech; tests techtest,plantest|Note vibrato enum exposed to playback generation.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/vibrato), pp.112–127|
|T12|Slight/wide bridge vibrato|missing|cmd,beattech|No beat/bridge vibrato command distinct from whammy curve.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/vibrato), pp.112–127|
|T13|Natural/artificial/pinch/tap/semi harmonics|implemented|tech; tests techtest,rendertest|All public harmonic types/value validated and model/native pitch paths exist.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/harmonics), pp.112–127|
|T14|Trill with speed and alternate pitch|implemented|tech; tests techtest,replaytest|Trill pitch/speed editable; repeated attacks asserted.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/ornements-expressive-effects/trills-turns), pp.112–127|
|T15|Upper/lower mordent and turn/inverted turn|implemented|tech; tests techtest,plantest|Public ornament enums exposed to generator.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/ornements-expressive-effects/mordents), pp.112–127|
|T16|Tremolo picking|implemented|beattech; tests techtest,replaytest|Speed converted to marks; repeated attacks/ticks covered.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/tremolo-picking), pp.112–127|
|T17|Buzz-roll tremolo notation interchange|partial|beattech,gpwrite; tests coverage|Native buzz-roll field writable; GP export reimports Default style.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/tremolo-picking), pp.112–127|
|T18|Brush and arpeggio direction/duration|implemented|beattech; tests techtest,plantest|Brush public enum/duration exposed and generated attack timing retained.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/rasgueado-brush-arpeggio), pp.112–127|
|T19|Rasgueado patterns|missing|cmd,beattech|No rasgueado pattern command.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/rasgueado-brush-arpeggio), pp.112–127|
|T20|Left/right fingering including piano fingerings|partial|tech,editor; tests techtest|Fretted selected-note fingers editable; piano notes cannot yet be authored.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/effects), pp.24–34,112–127|
|T21|Left-hand tapping|implemented|tech; tests techtest|isLeftHandTapped command and native mapping exist.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/touch-effects/legato), pp.112–127|
|T22|Beat tapping/slap/pop playing technique|missing|cmd,beattech|Left-hand flag is present; beat tap/slap/pop commands absent.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/slap-pop-golpe), pp.112–127|
|T23|Finger/thumb golpe and dead slap|missing|cmd,beattech|Imported dead-slap handled by plan; no authoring controls.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/slap-pop-golpe), pp.112–127|
|T24|Up/down pick scrape|partial|tech; tests techtest|Public pick-slide enum exists; exact target scrape notation/audio unverified.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/pick-scrape), pp.112–127|
|T25|Pick stroke up/down|implemented|beattech; tests techtest|PickStroke enum editable and retained in model/GP probe.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/effects), pp.112–127|
|T26|Fade in, fade out and volume swell|missing|cmd,beattech|No fade/volume-swell command.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/fades), pp.112–127|
|T27|Sustain pedal press/release indications|missing|cmd,beattech; tests selecttest,rendertest|Imported sustain controller path exists; no authored pedal spans or indications.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/external-effects/sustain-pedal), pp.24–34,112–127|
|T28|Wah open/closed gestures|missing|cmd,beattech,fx|No wah authoring field or wah DSP block.|[manual](https://www.guitar-pro.com/docs/gp8/playeffects/external-effects/wah), pp.112–127|
|T29|All techniques editable on selections with clear/remove|partial|tech,techui; tests techtest|Supported fields clear per selected string; no general range/multi-voice edit.|[manual](https://www.guitar-pro.com/docs/gp8/score/note/symbols/effects), pp.112–127|

### Sound, mixer and effects

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|A01|Independent recorded guitar/bass synthesis|partial|sound,plan; tests rendertest|Four recorded voices with articulations exist; breadth and sound fidelity against target unproved.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/RSE-vs-MIDI), pp.180–193|
|A02|General MIDI melodic and percussion playback|implemented|plan,sound; tests rendertest,plantest|Bundled GM fallback and imported percussion render offline.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/RSE-vs-MIDI), pp.180–198|
|A03|Instrument/sound-bank breadth equivalent to target|partial|sound,settings|Recorded palette limited to four guitar/bass voices; GM fallback is not equivalent recording breadth.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.180–193|
|A04|Signature/factory sound preset catalog|partial|sound|Only clean/crunch/lead/bass/bypass presets; no comparable broad sound catalog.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/signature-sounds), pp.312–319|
|A05|User sound preset save/recall/manage library|missing|settings,sound|Document settings persist one configured sound, without reusable library.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/custom-sounds), pp.180–193|
|A06|Per-track amp/cabinet controls|partial|fx,sound; tests dsptest|4 amp/3 cabinet enums; target's amp topology/routing breadth unproved.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A07|Distortion/overdrive/fuzz effect families|partial|fx,sound; tests dsptest|Amp saturation exists; discrete overdrive/distortion/fuzz pedal types absent.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A08|Noise gate and compressor|implemented|fx,sound; tests dsptest|Gate/compressor enabled state and parameters available.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A09|Chorus|implemented|fx,sound; tests dsptest|Single adjustable chorus block exists.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A10|Flanger and phaser|missing|fx|No flanger/phaser DSP or parameters.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A11|Tremolo and vibrato audio effects|missing|fx|Notation vibrato exists; track amplitude/pitch modulation pedals absent.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A12|Octaver and pitch-shift/wham effects|missing|fx|No polyphonic pitch effect blocks.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A13|Wah and auto-wah effects|missing|fx|No swept resonant filter/envelope follower block.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A14|Track and master EQ capabilities|partial|fx; tests dsptest|Three-band track EQ only; graphic/expanded EQ and master routing absent.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A15|Room/hall/plate/spring reverb families|partial|fx; tests dsptest|One room/damping/mix reverb; distinct family controls absent.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A16|Tempo-synced delay and tape/digital variants|partial|fx,sound; tests dsptest|Adjustable delay exists with 16s cap; distinct variants absent.|[manual](https://www.guitar-pro.com/docs/gp8/appendix/effects), pp.320–323|
|A17|Pedalboard routing, ordering and separate chains|partial|fx,settings|Fixed gate→compressor→amp→cabinet→EQ→chorus→delay→reverb structure.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.23,180–193|
|A18|Master track effects/mastering and overall controls|missing|settings,fx|No master sound chain/master volume/pan controls; limiter is fixed implementation detail.|[manual](https://www.guitar-pro.com/docs/gp8/audio/score-mastering), pp.194–195|
|A19|Track volume, pan, mute and multiple solo|implemented|track,settings; tests rendertest|Saved stable-identity static mix controls exist.|[manual](https://www.guitar-pro.com/docs/gp8/audio/mixtable), pp.178–179|
|A20|Focus/unfocus selected track|missing|cmd,settings|Solo/mute present; continuous focus balance absent.|[manual](https://www.guitar-pro.com/docs/gp8/audio/mixtable), pp.24,178–179|
|A21|Volume/pan automation authoring and bypass|partial|cmd,settings,plan; tests plantest,rendertest,selecttest|Imported MIDI controls render; authoring/bypass absent and GP writer drops in-range curves.|[manual](https://www.guitar-pro.com/docs/gp8/audio/automations/volume-pan-tempo), pp.92–95,128|
|A22|Sound change automation and multiple sounds per track|partial|cmd,plan; tests plantest,rendertest|Imported chronological programs render; no named sound-switch editing/library.|[manual](https://www.guitar-pro.com/docs/gp8/audio/automations/sound-automation), pp.92–95,128,180–193|
|A23|Drum-element volume, pan, mute/solo and kit mix|missing|settings,sound|Only track-wide mix exists.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/drum-mix), pp.23–24,180–193|
|A24|Output audio-device selection|implemented|sound,player; tests rendertest|Enumerates/selects native system output; existing Windows capture receipt proves one real device.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/audio-midi), pp.307–310|
|A25|Input/output channels, backend and latency/buffer settings|partial|sound,player|Output device only; no input/channel/buffer/ASIO controls.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/audio-midi), pp.307–310|
|A26|External MIDI output ports and per-track routing|missing|settings,player|Internal MIDI synthesis/export exists; hardware MIDI output/routing absent.|[manual](https://www.guitar-pro.com/docs/gp8/audio/midi), pp.196–198|
|A27|MIDI bank MSB/LSB/channel/latency configuration|partial|plan,settings; tests plantest|Imported stream may retain bank/controllers; no authored device/channel/bank controls.|[manual](https://www.guitar-pro.com/docs/gp8/audio/midi), pp.196–198|
|A28|Live Line-In monitoring through sound chain|missing|settings,player|No audio input capture/monitor path or level meter.|[manual](https://www.guitar-pro.com/docs/gp8/audio/line-in), pp.199–201|
|A29|Locked independent Line-In sound and level|missing|settings|No Line-In state or independent preset lock.|[manual](https://www.guitar-pro.com/docs/gp8/audio/line-in), pp.24–25,199–201|
|A30|Per-note audio duration/offset/relative velocity|missing|cmd,tech|Written rhythm/dynamic enums only; no fine audio properties.|[manual](https://www.guitar-pro.com/docs/gp8/audio/note-settings), pp.24,176–177|
|A31|Audible/visual target comparison for all sounds|unverified|validation; tests rendertest|Nonzero PCM and limited accepted demos do not establish target sound equivalence.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/RSE-vs-MIDI), pp.180–193|

### Backing audio and practice

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|P01|Play/pause/stop and cursor synchronization|implemented|transport,player; tests transporttest,plantest|Native clock drives audio and notation cursor.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/play), pp.170–177|
|P02|Start playback from score cursor/selection|partial|transport,player,app|Explicit measure seek exists; score click selection does not generally establish playback start/range.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/play), pp.170–177|
|P03|Loop selected passage including partial bars|partial|transport,player; tests transporttest|Inclusive whole-measure loop only; no note/beat boundaries.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/play), pp.170–177|
|P04|Relative speed with arbitrary 10–300% values|partial|transport,player; tests transporttest|Seven choices 25–200%; no custom full target range.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/speed), pp.171–173|
|P05|Fixed BPM ignoring saved tempo changes|missing|transport,player|No fixed-tempo practice mode.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/speed), pp.172–173|
|P06|Progressive speed trainer|missing|transport,player|No start/end/step/repeat-count training configuration.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/speed), pp.173|
|P07|Audible metronome|implemented|transport,plan; tests transporttest,rendertest|Meter-aware clicks and on/off implemented.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome), pp.174–175|
|P08|Metronome level/sound and visual-only mode|partial|transport,player|UI uses fixed .4 gain on/off; no level/sound/visual controls.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome), pp.174–175|
|P09|Count-in and configurable count between loops|missing|transport,player|No count-in state/controls.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome), pp.174–175|
|P10|Visual metronome and visual countdown|missing|transport,app|No beat flash or countdown display.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome), pp.174–175|
|P11|Decimal and low tempo authoring|implemented|notation; tests notationtest,rendertest|Positive finite decimal BPM accepted; low-tempo renderer covered.|[manual](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome), pp.26,170–171|
|P12|Tempo curves, units and global relative tonality|partial|notation,transport; tests notationtest|Beat-position linear/step quarter-note BPM exists; tempo units/global relative key absent.|[manual](https://www.guitar-pro.com/docs/gp8/audio/automations/volume-pan-tempo), pp.92–95,128,170–177|
|P13|Import/embed/replace/remove backing audio|implemented|backing,backingio; tests backingtest|WAV/FLAC/MP3/OGG and embedded extraction; self-contained assets.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.202–216|
|P14|Backing start offset and occurrence-aware sync anchors|implemented|backing,plan; tests backingtest,plantest|Numeric offset and bar/occurrence/ratio/audio-ms anchors implemented.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.211–214|
|P15|Waveform grid, audio timeline and drag sync editor|missing|backing|No waveform, zoom, bar grid, drag markers or matched score/audio selection.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.204–214|
|P16|Sync-to-audio tempo generation and brackets|partial|backing,notation|Anchors warp backing mapping; no tempo extraction/score tempo update or entry/exit bracket editing.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.211–214|
|P17|Backing semitone/cents pitch shift|missing|settings,backing|No backing pitch/fine-tune properties.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.203,214–215|
|P18|Backing vocal/instrument/center/channel filters|missing|settings,backing|No audio filter modes.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.214–215|
|P19|Backing independent static mix|implemented|backing,settings; tests rendertest|Gain/pan/mute/solo interact with score track mix.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.202–216|
|P20|Backing/audio following full practice interpretations|partial|backing,player; tests backingtest|Speed/seek/loop/repeats supported; relative key/count-in/fermata/feel/focus absent or unverified.|[manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), pp.202–216|

### Import, export and interoperability

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|F01|Original GTP and all legacy GP import generations|unverified|nativeio,import|GTP not listed; alphaTab delegation and17 private files do not prove all old generations.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import), pp.218–225|
|F02|MIDI import with quantization/options|missing|nativeio,import|No MIDI import UI, options or mapped score-authoring path.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-midi), pp.219–223|
|F03|MusicXML import|missing|nativeio,import|No dedicated MusicXML intake/filter/options/validation despite library reader availability.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-musicxml-powertab-tabledit), pp.224|
|F04|Compressed MusicXML (.mxl) import|missing|nativeio,import|No archive intake or exposed import path.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-musicxml-powertab-tabledit), pp.224|
|F05|ASCII tablature import|missing|nativeio,cmd|No ASCII recognition/mapping/import dialog.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-ascii), pp.218|
|F06|PowerTab (.ptb) import|missing|nativeio,import|No PowerTab intake or options.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-musicxml-powertab-tabledit), pp.224|
|F07|TablEdit (.tef) import|missing|nativeio,import|No TablEdit intake or options.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/import-musicxml-powertab-tabledit), pp.224|
|F08|Batch legacy GP converter|missing|formats,app|No recursive folder conversion with type/destination options.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import/batch-converter), pp.225|
|F09|Modern Guitar Pro score export|partial|gpwrite; tests coverage,selecttest|GP7 writer emits GP but known dynamics/curve/phrase/automation losses remain.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66,227–232|
|F10|GP5 and GP6/GPX export|missing|formats,gpwrite|Only Gp7Exporter available in product.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/file-management), pp.66,227–232|
|F11|Standard MIDI export|implemented|midiexport; tests miditest|Independent decoder checks notes/programs/tempo/range/repeats/controllers.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-midi), pp.229|
|F12|MIDI overlapping bends and large arrangements|unverified|midiexport,validation; tests miditest|15 melodic-track cap and channel-wide bends are known; exact comparison to target's own limits unverified.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-midi), pp.229|
|F13|MusicXML export|missing|formats|No MusicXML exporter.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-musicxml), pp.229|
|F14|ASCII tablature export|missing|formats|No ASCII exporter.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-ascii), pp.228|
|F15|Paginated vector PDF export|implemented|pdf,formats; tests pdftest|Vector page packing/fonts and A4/Letter portrait/landscape exist.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-pdf), pp.229–230|
|F16|PNG graphic export|missing|formats|No raster image export.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-png), pp.231|
|F17|SVG graphic export (introduced in 8.1)|missing|formats|Internal SVG feeds PDF only; no user SVG export.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-svg), pp.231–232|
|F18|WAV audio export|implemented|formats,exportui; tests exportdesktop|44.1/48kHz16/24-bit shared renderer with measured frame counts.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F19|MP3 audio export|missing|formats|No MP3 encoder or destination.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F20|OGG audio export|missing|formats|OGG input is supported; output encoder absent.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F21|FLAC audio export|missing|formats|FLAC input supported; output encoder absent.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F22|AIFF audio export|missing|formats|No AIFF output.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F23|Audio encoding quality/bitrate/normalization options|missing|formats,exportui|WAV rate/depth controls only; codec quality and normalization absent.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F24|Selected tracks/staves/bar-range exports and separate stems|implemented|formats,exportui; tests selecttest,miditest,exportdesktop|Explicit track/staff/written-bar selection and separate PCM stems implemented.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227–232|
|F25|Audio export metronome/count-in choices|partial|formats,exportui|Metronome option exists; count-in absent.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-audio), pp.227|
|F26|Original GP runtime interoperability acceptance|unverified|validation; tests coverage|alphaTab reimport is same-library evidence; target runtime acceptance still unverified.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export), pp.227–232|
|F27|Import preservation of every target notation/audio/layout field|unverified|import,validation; tests plantest|Private attacks/source hashes and limited field probes do not prove full GP model preservation.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/import), pp.218–225|

### Display, engraving and printing

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|D01|Screen vertical/horizontal and page display modes|partial|view,app|One vertical scroll score; no page horizontal/grid or horizontal screen mode.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/page-screen), pp.55–58|
|D02|Arbitrary zoom, fit width and fit page|partial|app,view|Five zoom choices70–130%; no fit/arbitrary range.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/zoom), pp.55–58|
|D03|Single/multitrack/visible-track score selection|partial|view,app|Screen renders selected track only; multi-track export is separate.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/track-visibility), pp.55–58|
|D04|Global view timeline with track/bar/section overview|missing|app,track|Track list lacks bar timeline, section blocks and range handles.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/main-screen), pp.44–50|
|D05|Show/hide/resizable editor, inspector and mixer panels|partial|app|Only instrument panel toggle; main panels fixed.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/panels), pp.44–50|
|D06|Design mode bar widths and beat placement|missing|cmd,view|No drag width/beat spacing or alignment guides.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/design-mode), pp.73,79–80|
|D07|Bars per system and forced system breaks|implemented|structure; tests structuretest|Track default bars/system and line-break set implemented.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/design-mode), pp.73,79–80|
|D08|Per-system spacing and reset tools|missing|cmd,structure|Only bars/system and break indices; no individual spacing state.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/design-mode), pp.73,79–80|
|D09|Page size/orientation/margins/scale|partial|settings,pdf; tests pdftest|A4/Letter, orientation, one shared margin and scale only.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/page-format), pp.133–161|
|D10|Header/footer field visibility and placeholders|missing|settings,pdf|Generated title/artist/page number only; no configurable metadata placeholders.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/header-footer), pp.133–161|
|D11|System/staff spacing, braces, brackets and names|missing|settings,structure|No engraving stylesheet for these settings.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/systems-staves), pp.133–161|
|D12|Music/text fonts, sizes and notation style presets|missing|settings,view|Bundled Bravura/Noto fixed; no classic/jazz/rock style/text controls.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/texts-styles), pp.133–161|
|D13|Save/load/reuse stylesheet and force defaults|missing|settings|No stylesheet library or preference.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet), pp.133–161,300–302|
|D14|Tuning/capo/chord display positioning and formatting|missing|settings,view|Automatic notation renderer only; no presentation options.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/page-format), pp.133–161|
|D15|Tab rhythm, voice placement and hidden dynamics/rests|missing|settings,view|No per-voice rhythm placement/style switches.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/notation), pp.133–161|
|D16|Fingering notation style/language/placement|missing|settings,tech|Finger values exist but no notation stylesheet for placement/alphabet.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/notation), pp.133–161|
|D17|Technique notation preferences and collision options|missing|settings,view|No bend-real-pitch/HoPo/slide/trill/tied-note/tuplet/bracket formatting controls.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/stylesheet/notation), pp.133–161|
|D18|Print selected tracks/range from application|partial|formats,print; tests pdftest|Prepares selected PDF and opens external viewer; no integrated print dialog/settings.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/print), pp.233–234|
|D19|Physical printer and platform print acceptance|unverified|print,validation|Windows viewer handoff accepted; physical print/macOS/Linux viewer behavior unverified.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/print), pp.233–234|
|D20|Graphical export naming/placeholders/background options|missing|formats,exportui|Basic destination dialog only; no per-track placeholder/background/template controls.|[manual](https://www.guitar-pro.com/docs/gp8/import-export/export/export-pdf), pp.229–232|

### Composition, learning and hardware tools

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|U01|Manual chord diagrams with string positions|partial|notation,editor; tests notationtest,editortest|Name/base-fret/fret array stored; fingering/barre/theoretical structure controls absent.|[manual](https://www.guitar-pro.com/docs/gp8/tools/chords-diagrams), pp.236–239|
|U02|Theory-based chord builder and alternative shapes|missing|cmd,editor|No root/type/extensions/alterations/inversions/omissions or generated alternatives.|[manual](https://www.guitar-pro.com/docs/gp8/tools/chords-diagrams), pp.236–239|
|U03|Chord recognition from entered notes|missing|editor|Diagram name is arbitrary text; no pitch-set recognition.|[manual](https://www.guitar-pro.com/docs/gp8/tools/chords-diagrams), pp.236–239|
|U04|Personal chord library and chord audition|missing|settings,editor|No reusable chord catalog or audition button.|[manual](https://www.guitar-pro.com/docs/gp8/tools/chords-diagrams), pp.236–239|
|U05|Scale diagram authoring from scratch/selection|missing|cmd,notation|No scale diagram model/edit command.|[manual](https://www.guitar-pro.com/docs/gp8/tools/scales-diagrams), pp.22,240–246|
|U06|Scale library/search/audition and interval display|missing|cmd,app|No scale tool; target documents over1000 scales.|[manual](https://www.guitar-pro.com/docs/gp8/tools/scales), pp.240–246|
|U07|Find scales in selected passage|missing|cmd,app|No selection pitch analysis or ranked scale matches.|[manual](https://www.guitar-pro.com/docs/gp8/tools/scales), pp.240–246|
|U08|Semitone/chromatic selection/whole-score transpose|missing|cmd,structure|Staff sounding offset exists; no note/key/chord transposition tool.|[manual](https://www.guitar-pro.com/docs/gp8/tools/tools-transposition), pp.247–252|
|U09|Diatonic transposition|missing|cmd|No key-aware scale-degree transposition.|[manual](https://www.guitar-pro.com/docs/gp8/tools/tools-transposition), pp.247–252|
|U10|Chord diagram transposition|missing|cmd,notation|Manual chord labels/frets lack theoretical transposition metadata.|[manual](https://www.guitar-pro.com/docs/gp8/tools/tools-transposition), pp.247–252|
|U11|Physical fretboard/keyboard/drum active-note views|implemented|instrument,liveinstrument; tests instrumenttest|Independent realistic viewers highlight simultaneous active native-plan notes.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/instrument-views), pp.253–257|
|U12|Instrument view click-to-enter/delete notes|missing|instrument|Read-only props and SVG groups; no edit callback or clickable note targets.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/instrument-views), pp.253–257|
|U13|Instrument view selected beat/bar/next-beat modes|missing|instrument,liveinstrument|Only currently playing notes shown; no stopped-selection/bar/next view modes.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/instrument-views), pp.253–257|
|U14|Left-handed neck and simultaneous neck+keyboard|missing|instrument|One mode at a time; no mirrored frets or two simultaneous views.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/instrument-views), pp.253–257|
|U15|Scale overlays and note-name/view options|missing|instrument|No scale overlay/root marking/hover-option/drum-list settings.|[manual](https://www.guitar-pro.com/docs/gp8/display-options/instrument-views), pp.253–257|
|U16|MIDI note capture beat-by-beat|missing|cmd,player|No hardware input/capture process.|[manual](https://www.guitar-pro.com/docs/gp8/tools/midi-capture), pp.79–80,196–198|
|U17|MIDI sensitivity and channel-to-string mapping|missing|settings,player|No MIDI input configuration.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/audio-midi), pp.307–310|
|U18|Chromatic and polyphonic audio tuner|missing|player,settings|No audio input/pitch detector/tuner display.|[manual](https://www.guitar-pro.com/docs/gp8/tools/tuner), pp.258|
|U19|Fretlight playback/scale hardware integration|missing|player,settings|No Fretlight discovery/connection/light commands.|[manual](https://www.guitar-pro.com/docs/gp8/tools/fretlight), pp.260–262|

### Library, preferences and service workflows

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|L01|Integrated score library browsing/filtering|missing|app|No welcome/library or artist/title/instrument/genre filters.|[manual](https://www.guitar-pro.com/docs/gp8/basics/first-steps/welcome-page), pp.40–43|
|L02|mySongBook account/catalog and score access|missing|app|No service connector or entitled content/open workflow.|[manual](https://www.guitar-pro.com/docs/gp8/mysongbook/open-from-msb), pp.285–298|
|L03|mySongBook purchases/subscription/credits and free scores|missing|app|No purchase/entitlement/free-score UI.|[manual](https://www.guitar-pro.com/docs/gp8/mysongbook/purchase-from-msb), pp.285–298|
|L04|mySongBook offline purchased content and arrangements|missing|app|No entitled local cache/arrangement/version management.|[manual](https://www.guitar-pro.com/docs/gp8/mysongbook/search-from-msb), pp.285–298|
|L05|Score error display and navigation preferences|missing|settings,app|Edit overflow validation exists; no underfull/error-style/playhead color preferences.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/score-errors), pp.305|
|L06|Global author/user metadata defaults|missing|settings,cmd|No user-info preference/default transcriber/composer values.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/my-info), pp.306|
|L07|Default display/style/zoom/open behavior preferences|missing|app,settings|View/profile/speed are local state; no preference store for startup defaults.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/general), pp.300–302|
|L08|Input preferences: auto-duration, numpad, preview, diagram paste|missing|keys,settings|No score-input preference controls.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/interface), pp.303–304|
|L09|Audio test tone, input level and device diagnostics|partial|sound,player|Output device list exists; no test tone/input meter/buffer diagnostics.|[manual](https://www.guitar-pro.com/docs/gp8/preferences-stylesheet/preferences/audio-midi), pp.307–310|
|L10|Windows/macOS desktop feature behavior|unverified|validation|CI build and Windows sample capture do not establish all features on native Mac/Windows devices.|[manual](https://www.guitar-pro.com/docs/gp8/basics/installation/requirements), pp.5–11|

### Additional documented workflow detail

|ID|Requirement|Baseline status|Evidence|Current behavior / remaining gap|GP8 reference|
|---|---|---|---|---|---|
|W22|Expression Text and searchable Action List|missing|app,keys|No prefix-free chord/dynamic/key/clef/direction entry or searchable action browser.|[manual](https://www.guitar-pro.com/docs/gp8/tools/command-palette), pp.280–284|
|E21|Repeat selected bars/music a chosen number of times|missing|cmd,engine|No repeat-selection duplication command; repeat playback signs are separate.|[manual](https://www.guitar-pro.com/docs/gp8/tools/command-palette), pp.278–279|
|A32|Lock current track sound against sound automations|missing|settings,sound|Voice override is static source choice; no explicit active-sound lock with sound automation semantics.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.180–193|
|A33|Preview alternate sound presets during playback|missing|sound,player|No noncommitting hover/audition preview of alternate presets.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.180–193|
|A34|Sound-bank microphone and mono/stereo settings|missing|settings,sound|Recorded-voice selection has no microphone positions/mono-stereo bank parameters.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.180–193|
|A35|Percussion playing styles and extended kit variants|missing|cmd,settings|GM percussion playback exists; no authored stick/brush style or broad kit selection.|[manual](https://www.guitar-pro.com/docs/gp8/score/drums), pp.97–100,180–193|
|A36|Master volume/pan automation and automation visibility|missing|cmd,settings|No master automation model; tempo-mark hide/show controls also absent.|[manual](https://www.guitar-pro.com/docs/gp8/audio/automations/volume-pan-tempo), pp.92–95,128,194–195|
|A37|Duplicate/copy/paste individual sounds and pedals|missing|settings,fx|Fixed one-sound/one-block schema cannot duplicate a pedal or transfer a complete named sound.|[manual](https://www.guitar-pro.com/docs/gp8/audio/soundsetup/sound-settings), pp.180–193|

## Evidence register

Paths/line numbers are baseline-source anchors. SHA-256 and exact anchor strings are retained in JSON. Existing tests were inspected, not rerun.

- **cmd** — [src/edit-types.ts:43](../../src/edit-types.ts:43): Finite command union: basic/technique/rhythm/structure/annotation/audio/print only; omitted authoring fields are absent here.
- **app** — [src/App.tsx:23](../../src/App.tsx:23): Single DocumentController and selected track, local zoom/profile; no desktop menu/workspace/library/preferences routes.
- **keys** — [src/App.tsx:64](../../src/App.tsx:64): Handles arrows, digit fret drafts and Enter; other shortcuts are not implemented.
- **view** — [src/ScoreView.tsx:6](../../src/ScoreView.tsx:6): One selected track passed to native player view; beat/note click selection, fixed notation engine and scale/profile.
- **engine** — [src/engine.ts:135](../../src/engine.ts:135): Basic note/rest/rhythm/beat/bar/track edits and finite advanced adapter.
- **initial** — [src/engine.ts:57](../../src/engine.ts:57): Creates stringed Staff with supplied tuning; does not create percussion/unpitched/keyboard tracks.
- **import** — [src/engine.ts:71](../../src/engine.ts:71): Imports source through alphaTab public ScoreLoader; no dedicated format options.
- **gpwrite** — [src/engine.ts:291](../../src/engine.ts:291): Gp7Exporter is the sole GP writer.
- **nativeio** — [src-tauri/src/lib.rs:39](../../src-tauri/src/lib.rs:39): Native Open filter: tabplayer, gp, gpx, gp3, gp4, gp5. No alternate import UI.
- **nativewrite** — [src-tauri/src/lib.rs:173](../../src-tauri/src/lib.rs:173): Native .tabplayer Save/Save As with source guards and atomic write path.
- **controller** — [src/controller.ts:9](../../src/controller.ts:9): Transactional single document open/new/edit/undo/redo/save/export.
- **session** — [src-tauri/src/project.rs:176](../../src-tauri/src/project.rs:176): Immutable source plus edit history/project session, not multi-document application state.
- **editor** — [src/EditorPanel.tsx:14](../../src/EditorPanel.tsx:14): Selected string/fret editor; Set note disabled for percussion or zero tuning; single tuplet ratio/grace/text/chord controls.
- **tech** — [src/editor/techniques.ts:36](../../src/editor/techniques.ts:36): Validated selected-note flags/enums/curves/harmonic/trill; finite supported fields.
- **beattech** — [src/editor/techniques.ts:55](../../src/editor/techniques.ts:55): Beat fields: pick, brush, whammy, tremolo only.
- **links** — [src/editor/techniques.ts:23](../../src/editor/techniques.ts:23): Forward tie/hammer/slur links in same staff/voice, pitch/string rules and endpoint repair.
- **techui** — [src/editor/TechniquePanel.tsx:13](../../src/editor/TechniquePanel.tsx:13): Controls for supported note fields plus explicit ties/slurs and curves.
- **notation** — [src/editor/notation.ts:5](../../src/editor/notation.ts:5): Single-level beat ratio, meter/pickup/free-time/repeat/endings/section/tempo, key/clef, text/manual chord only.
- **structure** — [src/editor/structure.ts:6](../../src/editor/structure.ts:6): Retuning preserves string count; staff/voice creation/removal/copy and system breaks; no pitch refingering.
- **track** — [src/TrackPanel.tsx:10](../../src/TrackPanel.tsx:10): Track rename/program/tuning/mix UI; new track takes name, program and string tuning.
- **tunings** — [src/tuning-presets.ts:5](../../src/tuning-presets.ts:5): 25 built-in presets for guitar 6–9 and bass 4–6; Custom uses note-name entry.
- **transport** — [src/Transport.tsx:5](../../src/Transport.tsx:5): Play/pause/stop, 7 relative speed choices, whole-measure seek/loop and metronome on/off.
- **player** — [src/audio/NativePlaybackController.ts:12](../../src/audio/NativePlaybackController.ts:12): Native sample-clock transport, plans, selected-track cursor, controls and settings.
- **plan** — [src/audio/plan.ts:336](../../src/audio/plan.ts:336): Prepared alphaTab musical/MIDI stream drives native plan; imported support is distinct from authoring controls.
- **sound** — [src/audio/SoundPanel.tsx:26](../../src/audio/SoundPanel.tsx:26): 4 recorded voice overrides, GM, 5 preset IDs and fixed 8-block effects with output-device choice.
- **settings** — [src/edit-types.ts:39](../../src/edit-types.ts:39): Only static track sounds/mixes, backing and print settings; no master, drum-element mix, automation/preset libraries.
- **fx** — [src/edit-types.ts:23](../../src/edit-types.ts:23): Gate/compressor/4 amp models/3 cabinets/3-band EQ/chorus/delay/reverb in fixed structure.
- **backing** — [src/audio/BackingPanel.tsx:9](../../src/audio/BackingPanel.tsx:9): Import/remove/replace/embedded backing, offset/anchors and static gain/pan/mute/solo; no waveform UI.
- **backingio** — [src-tauri/src/runtime.rs:203](../../src-tauri/src/runtime.rs:203): Audio input filters accept WAV, FLAC, MP3, OGG.
- **instrument** — [src/instruments/InstrumentView.tsx:7](../../src/instruments/InstrumentView.tsx:7): Read-only score/track/staff/active PlanNote props; no editing callback.
- **liveinstrument** — [src/instruments/LiveInstrumentView.tsx:9](../../src/instruments/LiveInstrumentView.tsx:9): Selected track active native-playback note sampling drives read-only instrument views.
- **formats** — [src/export/types.ts:7](../../src/export/types.ts:7): Public exports: GP, MIDI, PDF, print handoff, WAV, stems only.
- **exportui** — [src/export/ExportDialog.tsx:4](../../src/export/ExportDialog.tsx:4): Selection and paper/audio export options; no alternate score/image/audio format encoders.
- **pdf** — [src/export/pdf.ts:30](../../src/export/pdf.ts:30): Vector systems packed into physical pages with own headers/footer; constrained layout settings.
- **print** — [src-tauri/src/export/print.rs:24](../../src-tauri/src/export/print.rs:24): Writes PDF then opens external default viewer; does not invoke a native printer dialog itself.
- **midiexport** — [src/export/midi.ts:27](../../src/export/midi.ts:27): Standard MIDI generation/export; its own channel allocation and selected occurrences.
- **readme** — [README.md:1](../../README.md:1): Project overview and current scope; overview text alone is not behavior proof.
- **validation** — [docs/validation/2026-10-14-tabplayer-expansion.md:54](../../docs/validation/2026-10-14-tabplayer-expansion.md:54): Explicit GP export losses, 15 melodic MIDI-track limit, platform/audio/printing/signing limits; old scope completion is not parity.
- **techtest** — [src/editor/techniques.test.ts:19](../../src/editor/techniques.test.ts:19): Inspected assertions exercise supported enums, independent curves, link endpoint repair and musical duration.
- **notationtest** — [src/editor/notation.test.ts:5](../../src/editor/notation.test.ts:5): Assertions check 1800/320 ticks, meter overflow rejection, endings bitmask, tempos, key/text/chord reopen.
- **structuretest** — [src/editor/structure.test.ts:12](../../src/editor/structure.test.ts:12): Assertions cover voice limits/alignment, internal links, staff/capo/transposition and layout.
- **replaytest** — [src/editor/replay.test.ts:22](../../src/editor/replay.test.ts:22): Assertions cover explicit slur reconstruction, relationship repair, program stream and attack/timing effects.
- **editortest** — [src/editor/panels.test.tsx:13](../../src/editor/panels.test.tsx:13): UI dispatch/readback assertions for selected-string fields, curves, structure, meter and chord dialog.
- **enginetest** — [src/engine.test.ts:1](../../src/engine.test.ts:1): Existing basic command assertions cover note/rest/duration/track/bar replay and capacity.
- **tunetest** — [src/tuning-presets.test.ts:1](../../src/tuning-presets.test.ts:1): Preset inventory/order/pitches/filtering/readback assertions, not complete vendor catalog parity.
- **transporttest** — [src/Transport.test.tsx:2](../../src/Transport.test.tsx:2): UI transport seek/loop/speed/metronome dispatch and validation assertions.
- **plantest** — [src/audio/plan.test.ts:30](../../src/audio/plan.test.ts:30): Generated attacks/off events compared to independent public MIDI generator, plus repeat/tempo/channel/provenance tests.
- **rendertest** — [src-tauri/tests/audio_render.rs:174](../../src-tauri/tests/audio_render.rs:174): Native assertions measure voice pitch/energy/envelopes/independent curves/controller sustain; not vendor sound comparison.
- **dsptest** — [src-tauri/tests/audio_dsp.rs:216](../../src-tauri/tests/audio_dsp.rs:216): Native spectral/level assertions exercise implemented fixed effects; no missing FX family proof.
- **backingtest** — [src-tauri/tests/audio_backing.rs:11](../../src-tauri/tests/audio_backing.rs:11): Backing decode/anchors/time-stretch tests; does not exercise absent waveform editor.
- **instrumenttest** — [src/instruments/InstrumentView.test.tsx:30](../../src/instruments/InstrumentView.test.tsx:30): Assertions inspect actual string/fret/key geometry, simultaneous voices and kit element highlights.
- **pdftest** — [src/export/pdf.test.ts:12](../../src/export/pdf.test.ts:12): Page dimensions, escaped text, vector systems and slur geometry assertions; no paper-print result.
- **miditest** — [src/export/midi.test.ts:13](../../src/export/midi.test.ts:13): Independent byte decoder asserts event pitches/ticks/programs/tempos/selected boundaries/channel limits.
- **coverage** — [src/editor/gp-coverage.test.ts:16](../../src/editor/gp-coverage.test.ts:16): Records before/after GP values for 21 groups; only asserts count/bytes, so NOT a passing fidelity test.
- **selecttest** — [src/export/selection.test.ts:41](../../src/export/selection.test.ts:41): Separately asserts selected model relationships and probes GP phrase slur/automation retention limits.
- **filetest** — [src-tauri/tests/project_files.rs:7](../../src-tauri/tests/project_files.rs:7): Atomic source/history/file preservation assertions; not autosave or crash recovery.
- **advanceddesktop** — [tests/desktop/advanced-editor.mjs:1](../../tests/desktop/advanced-editor.mjs:1): Desktop authored/history/restart fixture; scope is supported fields, not all GP symbols.
- **exportdesktop** — [tests/desktop/exports.mjs:1](../../tests/desktop/exports.mjs:1): Desktop file export snapshot/cancellation/current-speed workflows for existing formats.

## Independent next work groups

These are complete feature owners, not permission questions. Root must coordinate shared command schema/App/controller/native registration; independent modules and fixtures can be developed in parallel.

### G1: Score model and notation completion

**Requirements:** S01, N06, N10, N13, N14, N16, N17, N18, N19, N20, N21, N22, N24, N25, N26, N28, N29, T12, T19, T22, T23, T26, T27, T28, T24.

**Depends on:** Versioned finite command schema and both validators; Independent notation/timing fixtures.

**Closure:** Author every missing symbol; inspect rendered output, event timing and native history/reopen; interchange preserved.

### G2: Pitched/percussion tracks and interactive instrument entry

**Requirements:** S04, S06, S07, S08, S10, U12, U13, U14, U15, E05, T20.

**Depends on:** Pitch/percussion note targets independent of string/fret; Correct track taxonomy and staff identity.

**Closure:** Compose piano grand staff and drum kit, enter notes through actual instrument views, export/play exact pitches/articulations.

### G3: Selections, clipboard, lyrics and editing assistants

**Requirements:** E02, E03, E07, E08, E09, E10, E11, E12, E13, E14, E15, E16, E17, E18, E19, E20, S11, N09, T29, T05, E21.

**Depends on:** Explicit note/beat/bar/track range schema; Atomic batch edits and relationship repair.

**Closure:** Cross-track/document copying, special paste, lyrics, refingering and batch effects have one-step undo and exact boundary semantics.

### G4: File interchange and GP fidelity

**Requirements:** F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F12, F13, F14, F16, F17, F19, F20, F21, F22, F23, F25, F26, F27, T07, T09, T10, T17, N23, W02.

**Depends on:** Independent format decoders and public authored corpus; Never use same-library reimport as sole acceptance.

**Closure:** All target formats exposed and verified; GPIF retains exact previously lost fields; supplied GP8 runtime opens authored files.

### G5: Timing, practice and backing workstation

**Requirements:** P02, P03, P04, P05, P06, P08, P09, P10, P12, P15, P16, P17, P18, P20, A30.

**Depends on:** Score tick/occurrence model shared with transport; Independent note audio properties and pitch-preserving backing processing.

**Closure:** Partial loops, full speed range, fixed/progressive tempo, count-in/visual clicks, audio fine settings and waveform synchronization verified by captured output.

### G6: Sound automation, presets, mixer and missing DSP

**Requirements:** A01, A03, A04, A05, A06, A07, A10, A11, A12, A13, A14, A15, A16, A17, A18, A20, A21, A22, A23, A31, S22, S23, S24, A32, A33, A34, A35, A36, A37.

**Depends on:** Ordered FX chain model; Named user presets/sound switches; Native offline/live shared processing.

**Closure:** Author sound/volume/pan automation, master/drum mix and missing effect families; verify spectral/envelope/routing behavior and independent listening.

### G7: Composition helpers and complete tuning tools

**Requirements:** S13, S14, S15, S16, S18, S19, S20, S21, U01, U02, U03, U04, U05, U06, U07, U08, U09, U10.

**Depends on:** Instrument-independent pitch mapping; Structured chord/scale definitions and user libraries.

**Closure:** Theory results independently validated; pitch-preserving retuning/transposition updates notes/chords while retaining techniques.

### G8: Desktop documents, library and command workflow

**Requirements:** W05, W06, W07, W08, W09, W10, W11, W12, W13, W14, W15, W16, W17, W18, W19, W20, W21, S03, L01, L05, L06, L07, L08, W22.

**Depends on:** Document manager with isolated sessions; Persisted application preferences separate from document commands.

**Closure:** Multi-document tabs/templates/recovery/library/commands/preferences survive restart and failure without cross-document state leakage.

### G9: Engraving stylesheet, display and complete print flow

**Requirements:** D01, D02, D03, D04, D05, D06, D08, D09, D10, D11, D12, D13, D14, D15, D16, D17, D18, D19, D20, N02, N03.

**Depends on:** Persisted layout/style schema; Notation renderer capability or independent extension.

**Closure:** All target display/stylesheet settings reflected in screen and exported/printed pages; render every page and inspect physical output.

### G10: Hardware, audio I/O and service integrations

**Requirements:** A25, A26, A27, A28, A29, U16, U17, U18, U19, L02, L03, L04, L09, L10.

**Depends on:** Actual authorized devices/service access; Per-platform native I/O and integration testing.

**Closure:** MIDI/Line-In/tuner/Fretlight and entitled catalog flows use actual interfaces and receipts; retain explicit unresolved gaps where access is unavailable.

## Acceptance and scope cautions

The JSON contains a separate `acceptance_required` for every row. All required missing/partial/unverified rows must be closed with concrete behavior evidence before claiming feature parity. Test counts and row counts cannot substitute. Exact field checks, rendered notation, independently decoded musical/audio output, native history/reopen, target-runtime interchange and platform/device validation each cover different risks.

The existing expansion report explicitly records GP per-note dynamics loss, reduced bend/whammy curves/styles, buzz-roll style loss, omitted nonadjacent cross-string phrase slurs and omitted in-range volume/pan automation. Preserve these as hard defects until new independent export evidence closes them. A coverage test that merely records before/after and asserts 21 results is not a fidelity assertion.

Hardware/service limitations are retained as open capabilities. The app must not claim mySongBook/Fretlight/Line-In/MIDI input or external output merely because an internal simulation/placeholder exists. Author independent assets; use actual authorized service/device access for acceptance.

The [official PDF FAQ](https://support.guitar-pro.com/hc/en-us/articles/19237871925021-GP8-Can-I-convert-a-PDF-file-into-a-Guitar-Pro-file-with-Guitar-Pro-8) and [audio-transcription FAQ](https://support.guitar-pro.com/hc/en-us/articles/19213333798813-GP8-Can-I-convert-an-audio-file-into-a-Guitar-Pro-file) say GP8 does not automatically convert those inputs to notation. Those are not added parity obligations. Publisher signing, release credentials and actual cross-platform installation remain release checks; successful build jobs do not prove physical audio/printing behavior.
