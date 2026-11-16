import { useState, type ReactNode } from 'react';
import type { model } from '@coderline/alphatab';
import { useI18n } from '../i18n';
import type { EditCommand, MasterSettings } from '../edit-types';
import { BusyFieldset } from '../ui/BusyFieldset';
import { CommitField } from '../ui/CommitField';
import { Dialog } from '../ui/Dialog';
import { busyGuard } from '../ui/useBusyGuard';
import { AuthorDefaultsPanel } from '../editor/AuthorDefaultsPanel';
import { newScoreDefaults, writeAuthorDefaults } from '../workspace/author-defaults';
import { metadataFields } from '../editor/song';
import { ScoreStyleDialog } from './ScoreStyleDialog';
import { MasterSlots } from './MasterSlots';
import { PaletteGlyph } from '../shell/glyphs';
import './inspector-compact.css';

const metadataLabels = [['subTitle', 'editor.subtitle'], ['album', 'editor.album'], ['words', 'editor.lyrics_author'], ['music', 'editor.music_author'], ['copyright', 'editor.copyright'], ['tab', 'editor.transcriber']] as const;

/**
 * The inspector's Song tab, as Guitar Pro's has it: Information (title and artist, the rest behind More), Musical
 * notation (one row that opens the Score style dialog) and Sound mastering (four effect slots). Every field applies when it
 * is left and records nothing when it still holds what the score has.
 */
export function SongInspector({ score, busy, locked, onEdit, styleGroups, master, masterDisabled, onMaster }: {
  score: model.Score;
  /** An edit is in flight. */
  busy: boolean;
  /** The score is finalized. */
  locked: boolean;
  onEdit: (command: EditCommand) => void | Promise<unknown>;
  styleGroups: { style: ReactNode; layout: ReactNode; page: ReactNode };
  master: MasterSettings | undefined;
  masterDisabled: boolean;
  onMaster: (next: MasterSettings) => Promise<unknown> | void;
}) {
  const { t } = useI18n();
  const [styleOpen, setStyleOpen] = useState(false), [defaultsOpen, setDefaultsOpen] = useState(false);
  const fields = Object.fromEntries(metadataFields.map(key => [key, score[key]])) as Pick<model.Score, typeof metadataFields[number]>;
  const info = (change: { title?: string; artist?: string; tempo?: number }) => {
    if (locked) return;
    const tempo = change.tempo ?? score.tempo;
    void onEdit({ type: 'setScoreInfo', title: change.title ?? score.title, artist: change.artist ?? score.artist, tempo, ...(tempo === score.tempo ? { preserveOpeningMark: true } : {}) });
  };
  const metadata = (key: typeof metadataFields[number], value: string) => { if (!locked) void onEdit({ type: 'setScoreMetadata', fields: { ...fields, [key]: value } }); };
  return <>
    <section className="inspector-section" aria-labelledby="inspector-song-information">
      <h3 id="inspector-song-information">{t('inspector.information')}</h3>
      <BusyFieldset busy={busy} className="song-information">
        <CommitField busy={busy} label={t('editor.title')} value={score.title} disabled={locked} onCommit={title => info({ title })} />
        <CommitField busy={busy} label={t('editor.artist')} value={score.artist} disabled={locked} onCommit={artist => info({ artist })} />
        <details className="inspector-more">
          <summary>{t('inspector.more')}</summary>
          <CommitField busy={busy} label={t('editor.initial_tempo')} type="number" min={1} value={String(score.tempo)} disabled={locked} onCommit={value => info({ tempo: Number(value) })} />
          {metadataLabels.map(([key, label]) => <CommitField busy={busy} key={key} label={t(label)} value={fields[key]} disabled={locked} onCommit={value => metadata(key, value)} />)}
          <CommitField busy={busy} label={t('editor.notices')} multiline value={fields.notices} disabled={locked} onCommit={value => metadata('notices', value)} />
          <CommitField busy={busy} label={t('editor.instructions')} multiline value={fields.instructions} disabled={locked} onCommit={value => metadata('instructions', value)} />
          <button type="button" aria-haspopup="dialog" onClick={() => setDefaultsOpen(true)}>{t('song_inspector.new_score_defaults')}</button>
        </details>
      </BusyFieldset>
    </section>
    <section className="inspector-section" aria-labelledby="inspector-song-notation">
      <h3 id="inspector-song-notation">{t('inspector.musical_notation')}</h3>
      <div className="stylesheet-row"><span className="stylesheet-label">{t('song_inspector.stylesheet')}</span>
        <button type="button" aria-haspopup="dialog" {...busyGuard({ onClick: () => setStyleOpen(true) })}><PaletteGlyph />{t('song_inspector.open_score_style')}</button></div>
    </section>
    <section className="inspector-section" aria-labelledby="inspector-sound-mastering">
      <MasterSlots master={master} disabled={masterDisabled} onChange={onMaster} />
    </section>
    {styleOpen && <ScoreStyleDialog {...styleGroups} onClose={() => setStyleOpen(false)} />}
    {defaultsOpen && <Dialog title={t('editor.author_defaults_title')} className="defaults-dialog" onClose={() => setDefaultsOpen(false)} dismissOnBackdrop>
      <AuthorDefaultsPanel score={score} load={newScoreDefaults} onSave={writeAuthorDefaults} open />
    </Dialog>}
  </>;
}
