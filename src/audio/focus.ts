import { defaultMix,type DocumentSettings } from '../document-settings';

/** A session-only focus on one track (by identity): a positive amount lowers every other track and
 * the backing, a negative amount (unfocus) lowers the focused track. */
export interface TrackFocus { track:string; amount:number }

/** The audio settings to play with focus applied. The saved settings are returned untouched when
 * there is no focus, so mixes and the project are never edited by it. */
export function focusedSettings(settings:DocumentSettings,trackIds:string[],focus:TrackFocus|null):DocumentSettings {
  if(focus&&!(Number.isFinite(focus.amount)&&Math.abs(focus.amount)<=1))throw new Error('Focus must be between -100% and 100%.');
  if(!focus||focus.amount===0||!trackIds.includes(focus.track))return settings;
  const others=focus.amount>0?1-focus.amount:1,own=focus.amount<0?1+focus.amount:1;
  const mixes={...settings.mixes};
  for(const id of trackIds){const mix=settings.mixes[id]??defaultMix();mixes[id]={...mix,gain:mix.gain*(id===focus.track?own:others)};}
  const backing=settings.backing&&others<1?{...settings.backing,mix:{...settings.backing.mix,gain:settings.backing.mix.gain*others}}:settings.backing;
  return {...settings,mixes,backing};
}
