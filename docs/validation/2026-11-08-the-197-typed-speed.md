# THE-197: typed practice speed

Date: 2026-11-08. Branch `agy/the-197-typed-speed`, based on `develop` at 84bb651 (including THE-193).
Resolves friction 9 in `docs/validation/2026-11-08-the-54-practise-walk.md`.

## Behavior

- Added a speed field (`SpeedField`) between Slower and Faster in the transport toolbar (`src/Transport.tsx`), replacing the static `<output>` readout.
- Typing an integer or decimal number (a decimal comma is read as a dot; hex, exponent and signed forms such as `0x1F`, `1e2`, `+50` are refused) from 10 to 300 and pressing Enter, or leaving the field (blur), sets the practice playback speed via `player.setSpeed(value)`.
- Escape restores the shown value to the current active playback speed and clears any inline error.
- Values out of range (< 10 or > 300) or non-numeric inputs (e.g. letters, empty string) are refused with an inline error message ("Speed must be a number from 10% to 300%."), setting `aria-invalid="true"` and `aria-describedby` on the input; playback speed remains unchanged.
- Choosing the current value does nothing: no command is sent, no error is shown, and nothing is recorded.
- The preset steps of Slower and Faster still work as before, stepping between presets including any custom typed speed, and updating the speed field.
- A fixed-tempo practice setting restricts the speed field with `aria-disabled="true"`, `readOnly={true}`, and title hint "Fixed tempo controls playback speed.", matching the behavior of the Slower and Faster buttons.
- Speed remains a session control: changing speed does not add edits to project undo history, and undo remains clean/disabled.
- Busy guard compliance (`src/ui/useBusyGuard.ts`): the speed field never receives the HTML `disabled` attribute for document busy states, preserving focus while busy and refusing changes until idle.
- The message has its own state (`speedError`), apart from the transport's shared error: it does not clear or mark an unrelated transport error, "More playback" does not show its error suffix for a typo, and a successful Slower/Faster or a valid entry clears it. A refused value stays in the field so the user can correct it. The field uses `inputMode="decimal"`.
- Compact toolbar styling is in `src/shell/transport.css` and `src/workstation/gp-shell.css`; the fit at 960 px is unverified (see Limits).

## Evidence

- `npx tsc --noEmit` runs clean with 0 errors.
- Vitest suite runs:
  - `src/Transport.test.tsx` (32 tests passed): covers typing speed, commit on Enter, commit on blur, boundary values 10 and 300, Escape restoration, refusal of below-range (< 10), above-range (> 300), non-numeric and empty values with inline alert, decimal comma and refused hex, exponent and signed forms, `aria-describedby` description, an unrelated transport error surviving a tab through the field, clearing the message on Escape, Slower or Faster, or a valid entry, Slower and Faster stepping from custom speed, choosing current value doing nothing, and fixed tempo restriction.
  - `src/Transport.workstation.test.tsx` (11 tests passed): covers transport controls retaining focus and aria-disabled when document becomes busy without dropping focus or HTML disabled attribute.
  - `src/Transport.performance.test.tsx` (4 tests passed): performance checks pass.
  - `src/i18n/surfaces.test.tsx` & `src/i18n/i18n.test.ts`: i18n catalogs and localized surfaces remain clean. `src/i18n/converted-surfaces.test.tsx` now includes Transport, so the label, title and error are checked to differ in et and de.
  - `src/App.test.tsx`: verifies that typing speed in the transport updates playback speed without adding to undo history or enabling undo.
- Desktop driver helper `tests/desktop/workstation-commands.mjs`: updated `setPlaybackSpeed` to read the input value or text content dynamically so Playwright drivers remain valid with the input field.

## Review

- One gesture is one session action; choosing current value does nothing.
- Accessibility: uses `aria-label`, `title`, `aria-disabled`, `aria-invalid`, and `aria-live` inline alert in `.transport-messages`.
- Localization: new keys `transport.speed_field` and `transport.speed_range_error` defined across `en`, `et`, and `de` message catalogs.

## Limits

- The claim that the field fits the 960 px toolbar without wrapping is unverified: no desktop driver or visual check was run.
- Desktop drivers in `tests/desktop/` were not run because they require port 9223 and the desktop test binary.
- Translations in Estonian (`et`) and German (`de`) were authored for this task and have not been reviewed by a native speaker; no native speaker reviewed the et and de text.
- Audio synthesis fidelity and timing precision were not judged by ear in this interface slice.
