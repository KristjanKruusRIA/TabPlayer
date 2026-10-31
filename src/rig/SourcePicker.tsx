import { useI18n } from '../i18n';
import { automaticVoice, voiceIds, voiceNames } from '../audio/sound-model';
import type { VoiceId } from '../audio/sound-model';
import type { SoundEditing } from '../audio/useSoundEditing';
import { Segmented } from '../ui';
import { busyGuard } from '../ui/useBusyGuard';
import { SourceArt, TrackGlyph, trackKind } from './SourceArt';
import type { RigTrack } from './SoundRig';

const shortNames:Record<VoiceId,string>={gm:'GM','green-guitar':'Green','black-guitar':'Black','darkblack-bass':'Darkblack','babyblue-bass':'Babyblue'};
type Choice='auto'|VoiceId;

/** Where the sound comes from, as the instruments themselves: one drawing for each source the engine has, and Automatic, which
 * plays as whichever the track's own instrument calls for. It is a radio group, so the arrow keys move and choose; choosing
 * is the same one edit as before. Each option has its own audition button, in a group of its own beside the radios, to preview that source without an edit. */
export function SourcePicker({editing,track}:{editing:SoundEditing;track:RigTrack|undefined}) {
  const { t } = useI18n();
  const {current,busy,previewer,showingPreview,previewChoice}=editing;
  const resolved=automaticVoice(track?.program??0,track?.percussion??false);
  const chosen:Choice=current.voiceId===null?'auto':(current.voiceId as VoiceId);
  const nameOf=(choice:Choice)=>choice==='auto'?`Automatic instrument, plays as ${voiceNames[resolved]}`:voiceNames[choice];
  const choices=['auto',...voiceIds] as Choice[];
  // Radio i sits in column 2i+1 and its Hear button in 2i+2 of one grid, so the buttons stay out of the radio group yet beside their options.
  const options=choices.map((choice,index)=>({
    value:choice,ariaLabel:nameOf(choice),style:{gridColumn:index*2+1},
    label:<span className="rig-source" data-auto={choice==='auto'||undefined} title={nameOf(choice)}>
      <SourceArt source={choice==='auto'?resolved:choice} className="rig-source-art"/>
      <span className="rig-source-name">{choice==='auto'?<>{t('rig.auto')}<span className="rig-source-to">→{shortNames[resolved]}</span></>:<><span className="rig-name-short">{shortNames[choice]}</span><span className="rig-name-full">{voiceNames[choice]}</span></>}</span>
    </span>,
  }));
  return <div className="rig-source-picker">
    <Segmented className="rig-sources" label={t('rig.sound_source')} value={chosen} disabled={busy} options={options} onChange={choice=>void editing.setVoice(choice==='auto'?null:choice)}/>
    {previewer&&<div className="rig-hears" role="group" aria-label={t('rig.hear_source_group')}>{choices.map((choice,index)=>{
      const hearing=showingPreview&&previewChoice===`voice:${choice}`;
      return <button key={choice} type="button" aria-pressed={hearing} aria-label={`Hear ${nameOf(choice)}`} style={{gridColumn:index*2+2}}
        {...busyGuard({busy,className:'rig-hear rig-hear-source',onClick:event=>editing.choosePreview(hearing?'':`voice:${choice}`,event.currentTarget)})}>{t('rig.hear')}</button>;
    })}</div>}
  </div>;
}

/** The score's tracks, each as a small drawing of its instrument and its name. A radio group where arrow keys move to and select a track. */
export function TrackStrip({tracks,trackId,onTrack}:{tracks:readonly RigTrack[];trackId:string;onTrack:(id:string)=>void}) {
  const { t } = useI18n();
  return <Segmented className="rig-tracks" label={t('workspace.track')} value={trackId} onChange={onTrack} options={tracks.map(track=>({
    value:track.id,ariaLabel:track.name,
    label:<span className="rig-track" title={track.name}><TrackGlyph kind={trackKind(track.program??0,track.percussion??false)}/><span className="rig-track-name">{track.name}</span></span>,
  }))}/>;
}
