import { useI18n, type MessageKey } from '../i18n';
import {
  automaticVoice,
  availablePickupsForVoice,
  gp8SetGroups,
  playsRecordedKit,
  resolvedGp8Set,
  voiceDisplayName,
  voiceNames,
  type VoiceId,
} from '../audio/sound-model';
import { PickupOptions } from '../audio/SoundSourceOptions';
import { useSoundbankStatus } from '../audio/soundbank-store';
import type { SoundEditing } from '../audio/useSoundEditing';
import type { PickupPosition } from '../edit-types';
import { Segmented } from '../ui';
import { busyGuard, busySelect } from '../ui/useBusyGuard';
import { SourceArt, TrackGlyph, trackKind } from './SourceArt';
import type { RigTrack } from './SoundRig';

type Choice = 'auto' | VoiceId;

/**
 * Sound source selection in the Sound Rig: Automatic (showing the resolved GP8 or GM instrument)
 * vs General MIDI in a segmented toggle with audition buttons, plus a grouped GP8 instrument set
 * dropdown and pickup position selector whenever a local GP8 soundbank is active.
 */
export function SourcePicker({ editing, track }: { editing: SoundEditing; track: RigTrack | undefined }) {
  const { t } = useI18n();
  const status = useSoundbankStatus();
  const { current, busy, previewer, showingPreview, previewChoice } = editing;
  const program = track?.program ?? 0;
  const percussion = track?.percussion ?? false;
  const resolved = automaticVoice(program, percussion, status, current.drumKit);
  const autoSet = resolvedGp8Set(null, program, percussion, current.drumKit, status);
  const activeSet = resolvedGp8Set(current.voiceId, program, percussion, current.drumKit, status);
  const kit = playsRecordedKit(program, percussion, current.drumKit, status);
  const pickups = availablePickupsForVoice(current.voiceId, program, percussion, current.drumKit, status);
  const groups = gp8SetGroups(status, percussion);

  const chosen: Choice = current.voiceId === null ? 'auto' : current.voiceId;
  const isCustomVoice = chosen !== 'auto' && chosen !== 'gm';
  const choices: Choice[] = isCustomVoice ? ['auto', chosen, 'gm'] : ['auto', 'gm'];

  const shortAuto = kit
    ? autoSet?.name ?? t('rig.recorded_kit_short')
    : autoSet?.name ?? 'GM';
  const nameOf = (choice: Choice) => {
    if (choice === 'auto') {
      return kit
        ? t('sound.recorded_drum_kit')
        : autoSet
          ? t('rig.auto_gp8', { name: autoSet.name })
          : `Automatic instrument, plays as ${voiceNames.gm}`;
    }
    return voiceDisplayName(choice, program, percussion, current.drumKit, status);
  };

  const options = choices.map((choice, index) => {
    const src = choice === 'auto' ? resolved : choice;
    const artCat =
      choice === 'auto'
        ? autoSet?.category
        : choice === 'gm'
          ? undefined
          : activeSet?.category;
    return {
      value: choice,
      ariaLabel: nameOf(choice),
      style: { gridColumn: index * 2 + 1 },
      label: (
        <span className="rig-source" data-auto={choice === 'auto' || undefined} title={nameOf(choice)}>
          <SourceArt
            source={src}
            category={artCat}
            percussion={choice === 'auto' ? percussion : undefined}
            className="rig-source-art"
          />
          <span className="rig-source-name">
            {choice === 'auto' ? (
              <>
                {t('rig.auto')}
                <span className="rig-source-to">→{shortAuto}</span>
              </>
            ) : choice === 'gm' ? (
              <>
                <span className="rig-name-short">GM</span>
                <span className="rig-name-full">{voiceNames.gm}</span>
              </>
            ) : (
              voiceDisplayName(choice, program, percussion, current.drumKit, status)
            )}
          </span>
        </span>
      ),
    };
  });

  return (
    <>
      <div className="rig-source-picker">
        <Segmented
          className="rig-sources"
          label={t('rig.sound_source')}
          value={chosen}
          disabled={busy}
          options={options}
          onChange={choice => void editing.setVoice(choice === 'auto' ? null : choice)}
        />
        {previewer && (
          <div className="rig-hears" role="group" aria-label={t('rig.hear_source_group')}>
            {choices.map((choice, index) => {
              const hearing = showingPreview && previewChoice === `voice:${choice}`;
              return (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={hearing}
                  aria-label={`Hear ${nameOf(choice)}`}
                  style={{ gridColumn: index * 2 + 2 }}
                  {...busyGuard({
                    busy,
                    className: 'rig-hear rig-hear-source',
                    onClick: event =>
                      editing.choosePreview(hearing ? '' : `voice:${choice}`, event.currentTarget),
                  })}
                >
                  {t('rig.hear')}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {groups.length > 0 && (
        <label className="rig-field">
          <span className="rig-field-name">{t('rig.choose_gp8')}</span>
          <select
            className="rig-select"
            aria-label={t('rig.choose_gp8')}
            value={chosen === 'auto' || chosen === 'gm' ? '' : chosen}
            {...busySelect(busy)}
            onChange={e => void editing.setVoice(e.target.value || null)}
          >
            <option value="">{autoSet ? t('sound.automatic_named', { name: autoSet.name }) : t('sound.automatic_instrument')}</option>
            {groups.map(group => (
              <optgroup
                key={group.category}
                label={t(`sound.gp8_group_${group.category}` as MessageKey)}
              >
                {group.sets.map(set => (
                  <option key={set.id} value={`gp8:${set.id}`}>
                    {set.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      {pickups.length > 1 && (
        <label className="rig-field">
          <span className="rig-field-name">{t('sound.pickup')}</span>
          <select
            className="rig-select"
            aria-label={t('sound.pickup')}
            value={current.pickup ?? ''}
            {...busySelect(busy)}
            onChange={e =>
              void editing.setPickup((e.target.value || undefined) as PickupPosition | undefined)
            }
          >
            <PickupOptions pickups={pickups} />
          </select>
        </label>
      )}
    </>
  );
}

/** The score's tracks, each as a small drawing of its instrument and its name. A radio group where arrow keys move to and select a track. */
export function TrackStrip({
  tracks,
  trackId,
  onTrack,
}: {
  tracks: readonly RigTrack[];
  trackId: string;
  onTrack: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Segmented
      className="rig-tracks"
      label={t('workspace.track')}
      value={trackId}
      onChange={onTrack}
      options={tracks.map(track => ({
        value: track.id,
        ariaLabel: track.name,
        label: (
          <span className="rig-track" title={track.name}>
            <TrackGlyph kind={trackKind(track.program ?? 0, track.percussion ?? false)} />
            <span className="rig-track-name">{track.name}</span>
          </span>
        ),
      }))}
    />
  );
}
