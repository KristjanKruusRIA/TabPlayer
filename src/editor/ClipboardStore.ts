import type { MusicClip } from './clipboard-types';
import { readMusicClip } from './clipboard-source';

/** App-owned musical clipboard; document replacement does not own its lifetime. */
export class ClipboardStore {
  private clip:MusicClip|null=null;
  get():MusicClip|null {return this.clip?structuredClone(this.clip):null;}
  set(clip:MusicClip):void {this.clip=readMusicClip(clip);}
}
