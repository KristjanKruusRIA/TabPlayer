import {invoke} from '@tauri-apps/api/core';
import type {NativeSessionBridge} from './recovery-types';

export const nativeSessionBridge:NativeSessionBridge={
  startup:()=>invoke('session_startup'),
  resolve:(token,documentIds)=>invoke('session_resolve',{token,documentIds}),
  setView:(documentId,view)=>invoke('workspace_set_view',{documentId,view}),
  setPreferences:restorePreviousSession=>invoke('session_preferences_set',{restorePreviousSession}),
  status:()=>invoke('recovery_status'),
  retry:()=>invoke('recovery_retry'),
  shutdown:documents=>invoke('session_shutdown',{documents}),
  resume:()=>invoke('session_resume'),
};
