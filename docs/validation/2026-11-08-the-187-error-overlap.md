# THE-187: playback error line over the "Seek measure" label

Date: 2026-11-08. Branch `fix/the-187-error-overlap`, from develop abd7a9a.

## Cause

In the toolbar (`src/workstation/gp-shell.css`) the feedback line `.transport-messages` is absolutely positioned at `top:100%` of the transport, so it does not grow the toolbar. The More playback panel (`.transport-more-content`, `src/shell/transport.css`) opens downward at `top:calc(100% + 1px)` of the same box. Both started at the transport's bottom edge, so the error line (y 82 to 98) sat on the panel (top y 79), over the "Seek measure" label. The cause was width independent; 960 px was only where the driver measured it.

## Fix

`Transport.tsx` measures the feedback line while it is absolutely positioned (ResizeObserver, so wrapping is followed) and publishes its height as `--transport-messages-h` on the transport. `gp-shell.css` starts the panel at `calc(100% + 1px + var(--transport-messages-h,0px))`. The error stays visible in place, just under the transport and above the panel; nothing is hidden or truncated. With no feedback the variable is 0 and the panel is where it was.

## Evidence

Vitest cannot lay out CSS, so the new test in `src/Transport.workstation.test.tsx` covers the part it can: the height variable follows the feedback line (0 px, 17 px with an error, 0 px again). The placement itself is covered by the desktop driver, which now also asserts at 960, 1280 and 1600 px that the error overlaps no control, is topmost, and ends above the panel.

Driver measurements (`parity-workstation`, error "Loop end must follow its start." with More playback open; before the fix at 960: feedback 82 to 98.2, panel top 79, overlapping "Seek measure"):

| Viewport | Feedback top to bottom | Panel top | Overlapping controls | Feedback on top |
|---|---|---|---|---|
| 960 | 82 to 98.2 | 104 | none | yes |
| 1280 | 82 to 98.2 | 104 | none | yes |
| 1600 | 84 to 100.2 | 106 | none | yes |

- `npm run typecheck`: clean. Vitest `src/Transport*`, `src/workstation`, `src/shell`: all pass.
- `node tests/desktop/parity-workstation.mjs` against a test app built from this worktree: passed, no page errors.

## Limits

Only the widths above were measured, in the single error case (loop end before start). Other messages (practice notice, loading audio) use the same line and the same offset but were not driven separately.
