import { useI18n } from '../i18n';
import { busyGuard } from '../ui/useBusyGuard';
import { neighbourSection,sectionAt,type SectionStart } from './sections';

/** Jumps between the named sections of the song; a section is named with the Section label of a measure. */
export function SectionsPanel({sections,bar,onGo}:{sections:readonly SectionStart[];bar:number;onGo:(bar:number)=>void}) {
  const { t } = useI18n();
  const current=sectionAt(sections,bar),previous=neighbourSection(sections,bar,'previous'),next=neighbourSection(sections,bar,'next');
  return <details className="editor-section"><summary>{t('sections.summary', { count: sections.length })}</summary>
    {sections.length?<>
      <div className="pair">
        <button {...busyGuard({unavailable:previous===null,onClick:()=>onGo(previous!)})}>{t('sections.previous')}</button>
        <button {...busyGuard({unavailable:next===null,onClick:()=>onGo(next!)})}>{t('sections.next')}</button>
      </div>
      <ul className="score-error-list" aria-label={t('sections.list_aria')}>{sections.map((section,index)=>
        <li key={section.bar}><button aria-current={index===current?'location':undefined} onClick={()=>onGo(section.bar)}>{t('sections.measure_item', { measure: section.bar + 1, name: section.name })}</button></li>)}</ul>
    </>:<p className="muted">{t('sections.empty')}</p>}
  </details>;
}
