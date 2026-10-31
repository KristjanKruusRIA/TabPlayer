/** What the person asked of a document's password protection. Every change to an existing password names the current one. */
export type ProtectionRequest =
  | { kind: 'unlockEditing'; password: string }
  | { kind: 'lockEditing' }
  | { kind: 'setEditPassword'; current: string | null; password: string }
  | { kind: 'removeEditPassword'; current: string }
  | { kind: 'setOpenPassword'; current: string | null; password: string }
  | { kind: 'removeOpenPassword'; current: string };

/** A password-protected file waiting for its password. Nothing of its contents is known, not even its title. */
export interface LockedDocument { token: string; path: string; fileName: string }

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const PASSWORD_RULE = `Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`;
export const PASSWORDS_DIFFER = 'The two passwords do not match.';

/** Why a new password cannot be used yet, or null. Counts characters as the person sees them, as the native check does. */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) return PASSWORD_RULE;
  if (password !== confirmation) return PASSWORDS_DIFFER;
  return null;
}
