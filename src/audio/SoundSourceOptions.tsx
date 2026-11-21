import type { PickupPosition } from '../edit-types';
import { useI18n, type MessageKey } from '../i18n';
import {
  gp8SetGroups,
  playsRecordedKit,
  resolvedGp8Set,
  voiceDisplayName,
  voiceNames,
} from './sound-model';
import type { Gp8Status } from './soundbank-store';

export function SoundSourceOptions({
  percussion,
  program,
  drumKit,
  voiceId,
  status,
}: {
  percussion: boolean;
  program: number;
  drumKit?: number;
  voiceId: string | null;
  status: Gp8Status;
}) {
  const { t } = useI18n();
  const autoSet = resolvedGp8Set(null, program, percussion, drumKit, status);
  const autoLabel = playsRecordedKit(program, percussion, drumKit, status)
    ? autoSet
      ? t('sound.automatic_named', { name: autoSet.name })
      : t('sound.recorded_drum_kit')
    : autoSet
      ? t('sound.automatic_named', { name: autoSet.name })
      : t('sound.automatic_instrument');
  const groups = gp8SetGroups(status, percussion);
  const listed = new Set<string>(['gm']);
  for (const g of groups) {
    for (const set of g.sets) {
      listed.add(`gp8:${set.id}`);
    }
  }
  const staleOrLegacy = voiceId && !listed.has(voiceId) ? voiceId : null;

  return (
    <>
      <option value="">{autoLabel}</option>
      <option value="gm">
        {percussion ? t('sound.general_midi_drums') : voiceNames.gm}
      </option>
      {staleOrLegacy && (
        <option value={staleOrLegacy}>
          {voiceDisplayName(staleOrLegacy, program, percussion, drumKit, status)}
        </option>
      )}
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
    </>
  );
}

export function PickupOptions({ pickups }: { pickups: readonly PickupPosition[] }) {
  const { t } = useI18n();
  return (
    <>
      <option value="">{t('sound.pickup_default')}</option>
      {pickups.map(pos => (
        <option key={pos} value={pos}>
          {t(`sound.pickup_${pos}` as MessageKey)}
        </option>
      ))}
    </>
  );
}
