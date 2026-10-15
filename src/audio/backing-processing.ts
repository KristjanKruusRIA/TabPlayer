import type { BackingProcessing } from '../edit-types';

export const defaultBackingProcessing = (): BackingProcessing => ({semitones:0,cents:0,filter:'none'});

export function backingProcessingKey(processing:BackingProcessing|null|undefined):string {
  const value=processing??defaultBackingProcessing();
  return JSON.stringify([value.semitones,value.cents,value.filter]);
}
