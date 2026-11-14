import { useSyncExternalStore } from 'react';
import type { InstrumentFocus } from './focus';
import { currentInstrumentFocus, subscribeInstrumentFocus } from './view-preferences';

/** The instrument view's Show choice (Playing notes, Selected beat, Selected bar, Next beat), followed live, whether or not the view is on screen. */
export const useInstrumentFocus = (): InstrumentFocus => useSyncExternalStore(subscribeInstrumentFocus, currentInstrumentFocus, currentInstrumentFocus);
