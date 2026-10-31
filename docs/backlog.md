# Backlog

Product ideas that sit outside the GP8 parity tracker. Nothing here is scheduled.

## Load VST plug-ins on a track (requested 2026-10-30)

Let the user load a VST onto a track, so a full guitar amp plug-in can run on top of the clean tone instead of the built-in drive and cabinet.

To settle at design time:
- **Crashes:** a plug-in is third-party native code. Hosting it in a separate process keeps a crash from taking down the app and its audio callback, at the cost of extra latency.
- **Format and licence:** VST3 first. Check the current SDK licence, and whether a hosting crate is good enough or a new dependency needs writing. Any new dependency gets a hot-path review.
- **Signal path:** where the plug-in sits in the track's chain, and which built-in stages it bypasses.
- **Editor:** opening the plug-in's own window from the app.
- **Latency:** reporting plug-in latency and keeping playback, the backing track and the metronome in sync.
- **Documents:** storing the plug-in reference and its state, and what happens when another machine does not have the plug-in. The fallback is the built-in tone with a notice, as for a missing user cabinet IR.
- **Export:** whether rendered audio includes plug-ins.
