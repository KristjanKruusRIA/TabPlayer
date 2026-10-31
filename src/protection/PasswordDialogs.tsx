import { useEffect,useId,useRef,useState } from 'react';
import type { FormEvent } from 'react';
import type { Protection } from '../project';
import { Dialog } from '../ui/Dialog';
import { busyGuard } from '../ui/useBusyGuard';
import { newPasswordProblem,PASSWORD_MAX,type ProtectionRequest } from './protection';
import './protection.css';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);

function PasswordField({label,value,onChange,shown,readOnly,autoFocus=false,invalid=false,describedBy,fieldRef}:{label:string;value:string;onChange:(value:string)=>void;shown:boolean;readOnly:boolean;autoFocus?:boolean;invalid?:boolean;describedBy?:string;fieldRef?:React.Ref<HTMLInputElement>}) {
  return <label className="tp-field protection-field"><span className="tp-field-label">{label}</span>
    <input ref={fieldRef} type={shown?'text':'password'} value={value} readOnly={readOnly} maxLength={PASSWORD_MAX*2} autoComplete="off" autoCapitalize="off" spellCheck={false} data-autofocus={autoFocus||undefined} aria-invalid={invalid||undefined} aria-describedby={describedBy}
      onChange={event=>{if(!readOnly)onChange(event.target.value);}}/>
  </label>;
}
function ShowPasswords({shown,onChange}:{shown:boolean;onChange:(shown:boolean)=>void}) {
  return <label className="check protection-show"><input type="checkbox" checked={shown} onChange={event=>onChange(event.target.checked)}/>Show passwords</label>;
}

/**
 * Asks for one password and tries it. A refused password keeps the dialog open with the reason, clears the field and puts
 * focus back in it, so a mistyped one can be retried. The dialog closes only through `onClose`, which the caller calls.
 */
function PasswordPrompt({title,intro,note,label,submitLabel,cancelLabel='Cancel',onTry,onClose,className}:{title:string;intro:string;note?:string;label:string;submitLabel:string;cancelLabel?:string;onTry:(password:string)=>Promise<void>;onClose:()=>void;className?:string}) {
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
    <button type="submit" {...busyGuard({busy:working,unavailable:!password,className:'tp-button primary'})}>{working?'Checking…':submitLabel}</button>
    <button type="button" {...busyGuard({busy:working,className:'tp-button',onClick:onClose})}>{cancelLabel}</button>
  </>;
  return <Dialog title={title} onClose={onClose} ariaDescribedBy={hint} busy={working} closeDisabled={working} className={`protection-dialog ${className??''}`} onSubmit={event=>void submit(event)} actions={actions}>
    <div className="protection-form">
      <p id={hint}>{intro}</p>
      <PasswordField fieldRef={field} label={label} value={password} onChange={setPassword} shown={shown} readOnly={working} autoFocus invalid={!!problem} describedBy={status}/>
      <ShowPasswords shown={shown} onChange={setShown}/>
      <p id={status} role={problem?'alert':'status'} className={problem?'error':'muted'}>{problem??(working?'Checking the password…':note??'')}</p>
    </div>
  </Dialog>;
}

/** Asks for the password of a protected file. A wrong one keeps the file waiting; Cancel stops waiting for it. */
export function OpenPasswordDialog({fileName,onTry,onCancel}:{fileName:string;onTry:(password:string)=>Promise<void>;onCancel:()=>void}) {
  return <PasswordPrompt title="Password required" label="Password" submitLabel="Open" onTry={onTry} onClose={onCancel}
    intro={`“${fileName}” is password-protected. Enter its password to open it.`}
    note="TabPlayer cannot recover a forgotten password."/>;
}

/** Asks for the password to edit; the score stays locked for editing until it is given. */
export function UnlockEditingDialog({onTry,onClose}:{onTry:(password:string)=>Promise<void>;onClose:()=>void}) {
  return <PasswordPrompt title="Unlock editing" label="Password to edit" submitLabel="Unlock editing" onTry={onTry} onClose={onClose}
    intro="This score is locked for editing. Enter its password to make changes. You can still play and read it."
    note="Editing stays unlocked until you lock it again or close the score."/>;
}

interface SectionText {title:string;blurb:string;warning:string;setNotice:string;changeNotice:string;removeNotice:string}
function ProtectionSection({text,isSet,status,onSet,onRemove,extra,blocked,onWorking}:{text:SectionText;isSet:boolean;status:string;onSet:(current:string|null,password:string)=>Promise<void>;onRemove:(current:string)=>Promise<void>;extra?:React.ReactNode;/** Why this password cannot be changed now. The controls stay, focusable, and refuse. */blocked?:string;onWorking:(working:boolean)=>void}) {
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
    if(isSet&&!current){setProblem('Enter the current password.');setNotice(null);first.current?.focus();return;}
    const invalid=newPasswordProblem(next,confirmation);
    if(invalid){setProblem(invalid);setNotice(null);return;}
    void run(()=>onSet(isSet?current:null,next),isSet?text.changeNotice:text.setNotice);
  };
  const remove=()=>{
    if(working)return;
    if(blocked){setProblem(blocked);setNotice(null);return;}
    if(!current){setProblem('Enter the current password to remove it.');setNotice(null);first.current?.focus();return;}
    void run(()=>onRemove(current),text.removeNotice);
  };
  return <section className="protection-section" aria-labelledby={heading}>
    <h3 id={heading}>{text.title}</h3>
    <p className="protection-status" role="status">{status}</p>
    <p className="muted">{text.blurb}</p>
    <p className="protection-warning">{text.warning}</p>
    <form onSubmit={submit} aria-label={text.title}>
      {isSet&&<PasswordField fieldRef={first} label="Current password" value={current} onChange={setCurrent} shown={shown} readOnly={working} describedBy={note}/>}
      <PasswordField fieldRef={isSet?undefined:first} label={isSet?'New password':'Password'} value={next} onChange={setNext} shown={shown} readOnly={working} describedBy={note}/>
      <PasswordField label="Confirm password" value={confirmation} onChange={setConfirmation} shown={shown} readOnly={working} describedBy={note}/>
      <ShowPasswords shown={shown} onChange={setShown}/>
      <div className="protection-actions">
        <button type="submit" {...busyGuard({busy:working,unavailable:!!blocked,className:'tp-button primary'})}>{isSet?'Change password':'Set password'}</button>
        {isSet&&<button type="button" {...busyGuard({busy:working,unavailable:!!blocked,className:'tp-button tp-danger',onClick:remove})}>Remove password</button>}
        {extra}
      </div>
      <p id={note} role={problem?'alert':'status'} className={problem?'error':'muted'}>{problem??(working?'Checking the password…':blocked??notice??'')}</p>
    </form>
  </section>;
}

const EDIT_TEXT:SectionText={
  title:'Password to edit',
  blurb:'Anyone can still open, read and play the score. TabPlayer asks for this password before it allows changes.',
  warning:'This is a deterrent, not encryption. The score stays readable in the file, so another program or someone editing the file by hand can get around it. Exports are not protected either, and a Guitar Pro export opened again in TabPlayer has no edit lock. Use a password to open for real protection.',
  setNotice:'Password to edit set. Save the score to keep it.',changeNotice:'Password to edit changed. Save the score to keep it.',removeNotice:'Password to edit removed. Save the score to keep this.',
};
const OPEN_TEXT:SectionText={
  title:'Password to open',
  blurb:'Encrypts the saved file. Without the password nobody can open it, and no part of the score can be read from the file.',
  warning:'There is no way to recover a forgotten password, and TabPlayer cannot reset it. Keep it somewhere safe. It applies when you save; recovery backups, templates and library details are not kept for a protected score. Exports and printed copies are plain: they carry no password, and a print leaves a temporary PDF that is removed when TabPlayer closes.',
  setNotice:'Password to open set. Save the score to encrypt the file.',changeNotice:'Password to open changed. Save the score to use it.',removeNotice:'Password to open removed. Save the score to keep it unencrypted.',
};

/** Sets, changes and removes a document's two passwords. Changes are not edits, so they have no undo step. */
export function ProtectionDialog({protection,dirty,onRequest,onClose}:{protection:Protection;dirty:boolean;onRequest:(request:ProtectionRequest)=>Promise<void>;onClose:()=>void}) {
  const editSet=protection.edit!=='none';
  const editStatus=protection.edit==='none'?'No password to edit is set.':protection.edit==='locked'?'A password to edit is set. Editing is locked.':'A password to edit is set. Editing is unlocked for now.';
  const openStatus=protection.open?'A password to open is set.':'No password to open is set.';
  // The dialog stays open while any change is being made, so its result is never lost and its fields are never left behind.
  const [locking,setLocking]=useState(false),[changing,setChanging]=useState(0);
  const working=(on:boolean)=>setChanging(count=>Math.max(0,count+(on?1:-1)));
  const lockNow=async()=>{if(locking)return;setLocking(true);try{await onRequest({kind:'lockEditing'});}catch{}finally{setLocking(false);}};
  const busy=locking||changing>0;
  return <Dialog title="Password protection" onClose={onClose} busy={busy} closeDisabled={busy} dismissOnBackdrop className="protection-dialog protection-manage" actions={<button type="button" {...busyGuard({busy,className:'tp-button primary',onClick:onClose})}>Done</button>}>
    <div className="protection-form">
      <ProtectionSection text={EDIT_TEXT} isSet={editSet} status={editStatus}
        onSet={(current,password)=>onRequest({kind:'setEditPassword',current,password})} onRemove={current=>onRequest({kind:'removeEditPassword',current})}
        onWorking={working} extra={protection.edit==='unlocked'?<button type="button" {...busyGuard({busy:locking,className:'tp-button',onClick:()=>void lockNow()})}>Lock editing now</button>:undefined}/>
      <ProtectionSection text={OPEN_TEXT} isSet={protection.open} status={openStatus} onWorking={working} blocked={protection.edit==='locked'?'Unlock editing first: the password to open cannot be changed while this score is locked for editing.':undefined}
        onSet={(current,password)=>onRequest({kind:'setOpenPassword',current,password})} onRemove={current=>onRequest({kind:'removeOpenPassword',current})}/>
      {dirty&&<p className="muted" role="status">Passwords take effect in the saved file when you save the score.</p>}
    </div>
  </Dialog>;
}
