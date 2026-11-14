import { useEffect, useMemo } from 'react';
import type { model } from '@coderline/alphatab';
import type { BeatTarget } from '../project';
import { useInstrumentFocus } from '../instruments/use-instrument-focus';
import { useFocusedNotes, type FocusPlayer } from '../instruments/use-focused-notes';
import { emptyFrame, frameFor, frameKey } from './frame';
import { fretlightSession, nativeFretlight, useFretlightConnected, type FretlightBridge } from './fretlight-session';

interface FeedProps { score: model.Score; target: BeatTarget; player: FocusPlayer | null; bridge?: FretlightBridge }

/** Works out the lit LEDs of the shown notes and hands each change to the session. Mounted only while the guitar is connected. */
function Following({ score, target, player, bridge = nativeFretlight }: FeedProps): null {
  const session = fretlightSession(bridge), focus = useInstrumentFocus();
  const staff = score.tracks[target.track]?.staves[target.staff];
  const { notes, held } = useFocusedNotes({ score, track: target.track, target, player, focus });
  const frame = useMemo(() => staff ? frameFor(staff, [...notes, ...held.map(note => ({ ...note, held: true }))]) : emptyFrame('not_six_string'), [staff, notes, held]);
  const key = frameKey(frame);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { session.sendFrame(frame); }, [session, key, frame.problem, frame.dropped]);
  return null;
}

/**
 * Keeps the Fretlight lights on the same notes the instrument view marks (THE-77), whether or not that view is on screen: the
 * shown notes come from the player and the selection, not from the view. It renders nothing, and does no work, until the
 * player has pressed Connect.
 */
export function FretlightFeed(props: FeedProps): React.JSX.Element | null {
  const connected = useFretlightConnected(fretlightSession(props.bridge ?? nativeFretlight));
  return connected ? <Following {...props} /> : null;
}
