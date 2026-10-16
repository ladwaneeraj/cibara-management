import { useState } from 'react'
import { Button, Field, Input, Modal } from '@/components/ui'
import { ApiError, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { signOutRealtime } from '@/lib/realtime'

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const logout = useAuth((s) => s.logout)
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setErr(null)
    if (next.length < 6) return setErr('New password must be at least 6 characters.')
    if (next !== again) return setErr('The two new passwords do not match.')
    if (next === cur) return setErr('New password must be different.')
    setBusy(true)
    try {
      await post('/api/v2/auth/password', { current_password: cur, new_password: next })
      onClose()
      await signOutRealtime()
      await logout('Password changed. Please sign in with your new password.')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not update password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Change password" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Update password</Button></>}>
      <div className="space-y-3">
        <Field label="Current password" htmlFor="pw-cur"><Input id="pw-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New password" htmlFor="pw-new"><Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Repeat new password" htmlFor="pw-again" error={err}><Input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <p className="text-xs text-slate-500">You will be signed out on every device afterwards.</p>
      </div>
    </Modal>
  )
}
