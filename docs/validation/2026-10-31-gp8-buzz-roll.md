# GP8 Parity T17: Buzz-roll Tremolo Notation Interchange

Investigation and test coverage for row T17: Buzz-roll tremolo notation interchange in Guitar Pro export and import.

## Behavior

- **Tremolo picking in GP interchange**:
  - Guitar Pro 7 / Guitar Pro 8 (`score.gpif` XML inside `.gp` archives) represents tremolo picking on a beat as `<Tremolo>1/2</Tremolo>` (1 mark / 8th note speed), `<Tremolo>1/4</Tremolo>` (2 marks / 16th note speed), or `<Tremolo>1/8</Tremolo>` (3 marks / 32nd note speed).
  - In alphaTab 1.8.4, `Gp7Exporter._writeBeatNode` translates `beat.tremoloPicking.marks` into `<Tremolo>1/2|1/4|1/8</Tremolo>`. It does not serialize `beat.tremoloPicking.style`.
  - In alphaTab 1.8.4, `GpifParser._parseBeatNode` translates `<Tremolo>` into a `new TremoloPickingEffect()`, parsing `marks` from the rational string (`1/2` -> 1, `1/4` -> 2, `1/8` -> 3). Because `new TremoloPickingEffect()` defaults to `TremoloPickingStyle.Default` (0) and `GpifParser` checks no style attributes or properties, re-import always yields `Default` style.
- **Target format verification (Guitar Pro 8 binary & GPIF specification)**:
  - Inspection of the official Guitar Pro 8.1.5 binary in `.analysis/guitar-pro-8.1.5-31/extracted/app/` reveals:
    - In `GPCore.dll`, the method signature is `gp::core::Beat::setTremolo(am::utils::rational const &)`. The core data structure stores only a rational speed; there is no tremolo style field or buzz roll property on `Beat`.
    - In `GPIO.dll`, GPIF export and import serialize and deserialize only rational speeds (`<Tremolo>1/2|1/4|1/8</Tremolo>`).
    - In `GuitarPro.exe` and all 13 translation files (`translations/*.qm`), tremolo picking options exist only for 8th, 16th, and 32nd notes (`gp_palette_effects_tremolo_picking_8th_note`, `16th_note`, `32th_note`). Guitar Pro itself does not feature a buzz-roll tremolo style.
- **Shared rule adherence**:
  - Shared rule: *"Do not invent facts. If a file format, tuning or behavior cannot be confirmed from this repository or a primary source, stop and report it instead of guessing. Name the source for every external fact."*
  - Task 4 rule: *"If the target format's value can't be confirmed from this repository or from a real file, stop and report that rather than guessing a value."*
  - Because no buzz-roll field exists in the target Guitar Pro GPIF format or in the Guitar Pro application, fabricating a custom XML tag or attribute in `score.gpif` would violate the specification.
- **Format comparison**:
  - **MusicXML**: Supports buzz roll explicitly via `<tremolo smufl="buzzRoll">`, implemented in `src/export/musicxml.ts` and supported by alphaTab's `MusicXmlImporter`.
  - **Guitar Pro 5**: Reports buzz roll loss explicitly via `report.lose('Buzz-roll tremolo picking becomes ordinary tremolo picking')` in `src/export/gp5.ts`.
  - **Guitar Pro 7/8**: Rational speeds are preserved (`1/2`, `1/4`, `1/8`), while roll style reverts to `Default` on re-import.

## Evidence

- **Primary source inspection**:
  - Inspected `node_modules/@coderline/alphatab/dist/alphaTab.core.mjs` lines 20607–20621 (`GpifParser`) and lines 66829–66839 (`Gp7Exporter`).
  - Inspected `.analysis/guitar-pro-8.1.5-31/extracted/app/GPCore.dll` symbol `?setTremolo@Beat@core@gp@@QEAAXAEBVrational@utils@am@@@Z`.
  - Inspected `.analysis/guitar-pro-8.1.5-31/extracted/app/GPIO.dll` strings around `<Tremolo>`.
  - Inspected `.analysis/guitar-pro-8.1.5-31/extracted/app/translations/GuitarProLocalisation_*.qm`.
- **Unit test suite**:
  - Added test suite in `src/interchange/gp.test.ts`:
    - `preserves default tremolo picking with 1 marks (Default) through GP export and import` (passes)
    - `preserves default tremolo picking with 2 marks (Default) through GP export and import` (passes)
    - `preserves default tremolo picking with 3 marks (Default) through GP export and import` (passes)
    - `pins buzz-roll tremolo behavior: speed is retained in GPIF rational while target format lacks roll style` (passes)
  - Ran `npx vitest run src/interchange/gp.test.ts --testTimeout=60000`: 20 of 20 tests passed.
  - Ran `npx tsc --noEmit`: exited 0 with no errors.

## Review

- Evaluated whether TabPlayer's custom GPIF post-processor (`src/interchange/notation.ts`) should inject an invented `<XProperty>` or XML element. Confirmed that unlike `invertBeamDirection` (which uses standard GP property `1124204545`) and `Fermatas` (which uses standard GP `<Fermatas>`), no standard GP property exists for buzz roll. Inventing an unconfirmed property would contradict the task requirement to stop and report rather than guessing a value.

## Limits

- Real Guitar Pro application verification was not performed (stated as out of scope in task handoff).
- GP5 export reports buzz roll loss as ordinary tremolo picking; alphaTab does not support buzz roll in GP3-5 binary format.
