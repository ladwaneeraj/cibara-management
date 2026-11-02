// Permission gate backed by the classic UI's CibaraAuth (static/auth.js).
// When no gate is available (dev harness / tests without CibaraAuth), show —
// the server still enforces the real permission on every request.
export function hasPerm(perm: string): boolean {
  const a = window.CibaraAuth
  if (a && typeof a.hasPermission === 'function') {
    try {
      return !!a.hasPermission(perm)
    } catch {
      return false
    }
  }
  return true
}
