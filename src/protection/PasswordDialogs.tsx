import { useEffect,useId,useRef,useState } from 'react';
import type { FormEvent } from 'react';
import type { Protection } from '../project';
import { Dialog } from '../ui/Dialog';
import { busyGuard } from '../ui/useBusyGuard';
import { newPasswordProblem,PASSWORD_MAX,PASSWORD_MIN,PASSWORD_RULE,PASSWORDS_DIFFER,type ProtectionRequest } from './protection';
import { useI18n } from '../i18n';
import './protection.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);

function PasswordField({label,value,onChange,shown,readOnly,autoFocus=false,invalid=false,describedBy,fieldRef}:{label:string;value:string;onChange:(value:string)=>void;shown:boolean;readOnly:boolean;autoFocus?:boolean;invalid?:boolean;describedBy?:string;fieldRef?:React.Ref<HTMLInputElement>}) {
  return <label className="tp-field protection-field"><span className="tp-field-label">{label}</span>
    <input ref={fieldRef} type={shown?'text':'password'} value={value} readOnly={readOnly} maxLength={PASSWORD_MAX*2} autoComplete="off" autoCapitalize="off" spellCheck={false} data-autofocus={autoFocus||undefined} aria-invalid={invalid||undefined} aria-describedby={describedBy}
      onChange={event=>{if(!readOnly)onChange(event.target.value);}}/>
  </label>;
}
function ShowPasswords({shown,onChange}:{shown:boolean;onChange:(shown:boolean)=>void}) {
  const { t } = useI18n();
  return <label className="check protection-show"><input type="checkbox" checked={shown} onChange={event=>onChange(event.target.checked)}/>{t('protection.show_passwords')}</label>;
}

/**
 * Asks for one password and tries it. A refused password keeps the dialog open with the reason, clears the field and puts
 * focus back in it, so a mistyped one can be retried. The dialog closes only through `onClose`, which the caller calls.
 */
function PasswordPrompt({title,intro,note,label,submitLabel,cancelLabel,onTry,onClose,className}:{title:string;intro:string;note?:string;label:string;submitLabel:string;cancelLabel?:string;onTry:(password:string)=>Promise<void>;onClose:()=>void;className?:string}) {
  const { t } = useI18n();
  const cancelText = cancelLabel ?? t('dialog.cancel');
  const [password,setPassword]=useState(''),[problem,setProblem]=useState<string|null>(null),[working,setWorking]=useState(false),[shown,setShown]=useState(false);
  const field=useRef<HTMLInputElement>(null),alive=useRef(true),hint=useId(),status=useId();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const submit=async(event?:FormEvent)=>{
    event?.preventDefault();
    if(working||!password)return;
    setWorking(true);setProblem(null);
    try{await onTry(password);}
    catch(error){
      if(!alive.current)return;
      // The password goes with the failed attempt; nothing keeps it for another one.
      setProblem(message(error));setPassword('');queueMicrotask(()=>field.current?.focus());
    }
    finally{if(alive.current)setWorking(false);}
  };
  const actions=<>
    <button type="submit" {...busyGuard({busy:working,unavailable:!password,className:'tp-button primary'})}>{working?t('protection.checking_button'):submitLabel}</button>
    <button type="button" {...busyGuard({busy:working,className:'tp-button',onClick:onClose})}>{cancelText}</button>
  </>;
  return <Dialog title={title} onClose={onClose} ariaDescribedBy={hint} busy={working} closeDisabled={working} className={`protection-dialog ${className??''}`} onSubmit={event=>void submit(event)} actions={actions}>
    <div className="protection-form">
      <p id={hint}>{intro}</p>
      <PasswordField fieldRef={field} label={label} value={password} onChange={setPassword} shown={shown} readOnly={working} autoFocus invalid={!!problem} describedBy={status}/>
      <ShowPasswords shown={shown} onChange={setShown}/>
      <p id={status} role={problem?'alert':'status'} className={problem?'error':'muted'}>{problem??(working?t('protection.checking_status'):note??'')}</p>
    </div>
  </Dialog>;
}

/** Asks for the password of a protected file. A wrong one keeps the file waiting; Cancel stops waiting for it. */
export function OpenPasswordDialog({fileName,onTry,onCancel}:{fileName:string;onTry:(password:string)=>Promise<void>;onCancel:()=>void}) {
  const { t } = useI18n();
  return <PasswordPrompt title={t('protection.open_dialog_title')} label={t('protection.password_label')} submitLabel={t('protection.open_submit')} onTry={onTry} onClose={onCancel}
    intro={t('protection.open_intro', { fileName })}
    note={t('protection.forgotten_warning')}/>;
}

/** Asks for the password to edit; the score stays locked for editing until it is given. */
export function UnlockEditingDialog({onTry,onClose}:{onTry:(password:string)=>Promise<void>;onClose:()=>void}) {
  const { t } = useI18n();
  return <PasswordPrompt title={t('protection.unlock_dialog_title')} label={t('protection.password_to_edit')} submitLabel={t('protection.unlock_submit')} onTry={onTry} onClose={onClose}
    intro={t('protection.unlock_intro')}
    note={t('protection.unlock_note')}/>;
}

interface SectionText {title:string;blurb:string;warning:string;setNotice:string;changeNotice:string;removeNotice:string}
function ProtectionSection({text,isSet,status,onSet,onRemove,extra,blocked,onWorking}:{text:SectionText;isSet:boolean;status:string;onSet:(current:string|null,password:string)=>Promise<void>;onRemove:(current:string)=>Promise<void>;extra?:React.ReactNode;/** Why this password cannot be changed now. The controls stay, focusable, and refuse. */blocked?:string;onWorking:(working:boolean)=>void}) {
  const { t } = useI18n();
  const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[confirmation,setConfirmation]=useState('');
  const [problem,setProblem]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[working,setWorking]=useState(false),[shown,setShown]=useState(false);
  const alive=useRef(true),first=useRef<HTMLInputElement>(null),note=useId(),heading=useId();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const clear=()=>{setCurrent('');setNext('');setConfirmation('');};
  const run=async(job:()=>Promise<void>,done:string)=>{
    setWorking(true);onWorking(true);setProblem(null);setNotice(null);
    try{await job();if(alive.current){clear();setNotice(done);}}
    catch(error){if(alive.current){setProblem(message(error));setCurrent('');queueMicrotask(()=>first.current?.focus());}}
    finally{onWorking(false);if(alive.current)setWorking(false);}
  };
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if(working)return;
    if(blocked){setProblem(blocked);setNotice(null);return;}
    if(isSet&&!current){setProblem(t('protection.enter_current'));setNotice(null);first.current?.focus();return;}
    const invalid=newPasswordProblem(next,confirmation);
    if(invalid){
      const localized = invalid === PASSWORD_RULE ? t('protection.rule', { min: PASSWORD_MIN, max: PASSWORD_MAX }) : invalid === PASSWORDS_DIFFER ? t('protection.differ') : invalid;
      setProblem(localized);setNotice(null);return;
    }
    void run(()=>onSet(isSet?current:null,next),isSet?text.changeNotice:text.setNotice);
  };
  const remove=()=>{
    if(working)return;
    if(blocked){setProblem(blocked);setNotice(null);return;}
    if(!current){setProblem(t('protection.enter_current_to_remove'));setNotice(null);first.current?.focus();return;}
    void run(()=>onRemove(current),text.removeNotice);
  };
  return <section className="protection-section" aria-labelledby={heading}>
    <h3 id={heading}>{text.title}</h3>
    <p className="protection-status" role="status">{status}</p>
    <p className="muted">{text.blurb}</p>
    <p className="protection-warning">{text.warning}</p>
    <form onSubmit={submit} aria-label={text.title}>
      {isSet&&<PasswordField fieldRef={first} label={t('protection.current_password')} value={current} onChange={setCurrent} shown={shown} readOnly={working} describedBy={note}/>}
      <PasswordField fieldRef={isSet?undefined:first} label={isSet?t('protection.new_password'):t('protection.password_label')} value={next} onChange={setNext} shown={shown} readOnly={working} describedBy={note}/>
      <PasswordField label={t('protection.confirm_password')} value={confirmation} onChange={setConfirmation} shown={shown} readOnly={working} describedBy={note}/>
      <ShowPasswords shown={shown} onChange={setShown}/>
      <div className="protection-actions">
        <button type="submit" {...busyGuard({busy:working,unavailable:!!blocked,className:'tp-button primary'})}>{isSet?t('protection.change_password'):t('protection.set_password')}</button>
        {isSet&&<button type="button" {...busyGuard({busy:working,unavailable:!!blocked,className:'tp-button tp-danger',onClick:remove})}>{t('protection.remove_password')}</button>}
        {extra}
      </div>
      <p id={note} role={problem?'alert':'status'} className={problem?'error':'muted'}>{problem??(working?t('protection.checking_status'):blocked??notice??'')}</p>
    </form>
  </section>;
}

/** Sets, changes and removes a document's two passwords. Changes are not edits, so they have no undo step. */
export function ProtectionDialog({protection,dirty,onRequest,onClose}:{protection:Protection;dirty:boolean;onRequest:(request:ProtectionRequest)=>Promise<void>;onClose:()=>void}) {
  const { t } = useI18n();
  const editSet=protection.edit!=='none';
  const editStatus=protection.edit==='none'?t('protection.edit_status_none'):protection.edit==='locked'?t('protection.edit_status_locked'):t('protection.edit_status_unlocked');
  const openStatus=protection.open?t('protection.open_status_set'):t('protection.open_status_none');
  // The dialog stays open while any change is being made, so its result is never lost and its fields are never left behind.
  const [locking,setLocking]=useState(false),[changing,setChanging]=useState(0);
  const working=(on:boolean)=>setChanging(count=>Math.max(0,count+(on?1:-1)));
  const lockNow=async()=>{if(locking)return;setLocking(true);try{await onRequest({kind:'lockEditing'});}catch{}finally{setLocking(false);}};
  const busy=locking||changing>0;
  const editText:SectionText={
    title:t('protection.edit_section_title'),
    blurb:t('protection.edit_blurb'),
    warning:t('protection.edit_warning'),
    setNotice:t('protection.edit_set_notice'),
    changeNotice:t('protection.edit_change_notice'),
    removeNotice:t('protection.edit_remove_notice'),
  };
  const openText:SectionText={
    title:t('protection.open_section_title'),
    blurb:t('protection.open_blurb'),
    warning:t('protection.open_warning'),
    setNotice:t('protection.open_set_notice'),
    changeNotice:t('protection.open_change_notice'),
    removeNotice:t('protection.open_remove_notice'),
  };
  return <Dialog title={t('protection.manage_title')} onClose={onClose} busy={busy} closeDisabled={busy} dismissOnBackdrop className="protection-dialog protection-manage" actions={<button type="button" {...busyGuard({busy,className:'tp-button primary',onClick:onClose})}>{t('protection.done')}</button>}>
    <div className="protection-form">
      <ProtectionSection text={editText} isSet={editSet} status={editStatus}
        onSet={(current,password)=>onRequest({kind:'setEditPassword',current,password})} onRemove={current=>onRequest({kind:'removeEditPassword',current})}
        onWorking={working} extra={protection.edit==='unlocked'?<button type="button" {...busyGuard({busy:locking,className:'tp-button',onClick:()=>void lockNow()})}>{t('protection.lock_now')}</button>:undefined}/>
      <ProtectionSection text={openText} isSet={protection.open} status={openStatus} onWorking={working} blocked={protection.edit==='locked'?t('protection.open_blocked_by_edit_lock'):undefined}
        onSet={(current,password)=>onRequest({kind:'setOpenPassword',current,password})} onRemove={current=>onRequest({kind:'removeOpenPassword',current})}/>
      {dirty&&<p className="muted" role="status">{t('protection.save_effect_note')}</p>}
    </div>
  </Dialog>;
}
