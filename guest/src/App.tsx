import {
  AlarmClock, Bell, BedDouble, Broom, Car, CheckCircle2, ChevronLeft, Clock, Copy, Info,
  ListChecks, LogOut, MessageCircle, MessageSquareWarning, Moon, Phone, Shirt, Sparkles, Star,
  Utensils, Wifi, Wrench, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  KINDS, MIN_GAP_MS, cancelRequest, connect, ensureUser, leave, login, rateStay, readFeedback,
  readSession, readSettings, sendRequest, toGuestError, touch, watchRequests, watchRoom,
  watchSession, type GuestRequest, type Kind, type Room, type Session, type Settings, type Status,
} from './api'

/* --------------------------- Small primitives --------------------------- */

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const ICONS: Record<Kind, ReactNode> = {
  room_service: <Utensils className="size-6" />,
  housekeeping: <Broom className="size-6" />,
  extra_items: <BedDouble className="size-6" />,
  laundry: <Shirt className="size-6" />,
  maintenance: <Wrench className="size-6" />,
  wake_up: <AlarmClock className="size-6" />,
  late_checkout: <Clock className="size-6" />,
  taxi: <Car className="size-6" />,
  do_not_disturb: <Moon className="size-6" />,
  complaint: <MessageSquareWarning className="size-6" />,
}

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  open: { label: 'Sent', cls: 'bg-warn-100 text-warn-600' },
  acknowledged: { label: 'Seen by staff', cls: 'bg-info-100 text-info-600' },
  done: { label: 'Done', cls: 'bg-ok-100 text-ok-600' },
  cancelled: { label: 'Cancelled', cls: 'bg-surface-200 text-ink-500' },
}

function Button({
  children, onClick, disabled, variant = 'primary', className, type = 'button',
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean
  variant?: 'primary' | 'ghost' | 'danger'; className?: string; type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-bold transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100',
        variant === 'primary' && 'bg-gradient-to-b from-accent-500 to-accent-600 text-white shadow-accent',
        variant === 'ghost' && 'bg-white text-ink-700 shadow-card ring-1 ring-surface-200',
        variant === 'danger' && 'bg-danger-100 text-danger-600',
        className,
      )}
    >
      {children}
    </button>
  )
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">{children}</p>
}

function Toast({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-6">
      <span className="rise-in rounded-full bg-ink-900 px-4 py-2 text-[13px] font-semibold text-white shadow-pop">{text}</span>
    </div>
  )
}

function useToast(): [string | null, (t: string) => void] {
  const [text, setText] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((t: string) => {
    setText(t)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setText(null), 2600)
  }, [])
  return [text, show]
}

function clock(ms?: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}
function dayTime(iso?: string, ms?: number): string {
  const d = iso ? new Date(iso) : ms ? new Date(ms) : null
  if (!d || isNaN(d.getTime())) return ''
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}
function minutesBetween(a?: number, b?: number): string {
  if (!a || !b) return ''
  const m = Math.max(0, Math.round((b - a) / 60000))
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`
}
function nightsSince(checkin?: string): number {
  if (!checkin) return 0
  const d = new Date(checkin.replace(' ', 'T'))
  if (isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000))
}

/* ------------------------------ Screens -------------------------------- */

type Stage =
  | { name: 'loading' }
  | { name: 'blocked'; message: string }
  | { name: 'login'; uid: string }
  | { name: 'home'; uid: string; session: Session; settings: Settings }
  | { name: 'ended'; uid: string; reason?: string }

export default function App() {
  const [stage, setStage] = useState<Stage>({ name: 'loading' })

  const enter = useCallback(async (uid: string, session: Session) => {
    try {
      const settings = await readSettings()
      setStage({ name: 'home', uid, session, settings })
    } catch (e) {
      const err = toGuestError(e)
      if (err.code === 'refused') setStage({ name: 'ended', uid, reason: 'closed' })
      else setStage({ name: 'blocked', message: err.message })
    }
  }, [])

  const boot = useCallback(async () => {
    setStage({ name: 'loading' })
    try {
      await connect()
      const user = await ensureUser()
      const session = await readSession(user.uid).catch(() => null)
      if (session && session.status === 'active' && session.expiresAtMs > Date.now()) {
        await enter(user.uid, session)
      } else {
        setStage({ name: 'login', uid: user.uid })
      }
    } catch (e) {
      setStage({ name: 'blocked', message: toGuestError(e).message })
    }
  }, [enter])

  useEffect(() => { void boot() }, [boot])

  if (stage.name === 'loading') return <Centered title="One moment" spinner />
  if (stage.name === 'blocked') return <Centered eyebrow="Guest services" title={stage.message} hint="Please tell reception if this keeps happening." />
  if (stage.name === 'login') return <Login uid={stage.uid} onDone={(s) => void enter(stage.uid, s)} />
  if (stage.name === 'ended') {
    return (
      <Ended
        reason={stage.reason}
        onAgain={() => setStage({ name: 'login', uid: stage.uid })}
      />
    )
  }
  return (
    <Home
      key={stage.uid + stage.session.room}
      uid={stage.uid}
      session={stage.session}
      settings={stage.settings}
      onEnded={(reason) => setStage({ name: 'ended', uid: stage.uid, reason })}
      onLeave={() => { void leave().then(boot) }}
    />
  )
}

function Centered({ eyebrow, title, hint, spinner }: { eyebrow?: string; title: string; hint?: string; spinner?: boolean }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-surface-100 px-6 text-center">
      <div className="max-w-sm">
        {spinner && <span className="mx-auto mb-4 block size-8 animate-spin rounded-full border-[3px] border-surface-300 border-t-accent-600" />}
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="mt-1 text-lg font-bold leading-snug text-ink-900">{title}</h1>
        {hint && <p className="mt-2 text-sm text-ink-500">{hint}</p>}
      </div>
    </main>
  )
}

function Login({ uid, onDone }: { uid: string; onDone: (s: Session) => void }) {
  const [room, setRoom] = useState('')
  const [mobile, setMobile] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError('')
    setBusy(true)
    try {
      onDone(await login(uid, room, mobile))
    } catch (e) {
      setError(toGuestError(e).message)
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-surface-100 px-6 pb-10 pt-14">
      <div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-accent-100 text-accent-600"><Bell className="size-6" /></div>
      <Eyebrow>Guest services</Eyebrow>
      <h1 className="mt-1 text-3xl font-bold text-ink-900">Welcome</h1>
      <p className="mt-2 text-sm text-ink-500">Room service, housekeeping and more, from your phone. Sign in with the details from check-in.</p>
      <form className="mt-8 flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">Room number</span>
          <input
            inputMode="numeric" autoComplete="off" placeholder="e.g. 204" value={room}
            onChange={(e) => setRoom(e.target.value)}
            className="w-full rounded-2xl bg-white px-4 py-4 text-2xl font-bold text-ink-900 shadow-card ring-1 ring-surface-200 outline-none placeholder:font-medium placeholder:text-ink-300 focus:ring-2 focus:ring-accent-500"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">Mobile number given at check-in</span>
          <input
            type="tel" inputMode="tel" autoComplete="tel" placeholder="10-digit mobile" value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            className="w-full rounded-2xl bg-white px-4 py-4 text-xl font-semibold tracking-wide text-ink-900 shadow-card ring-1 ring-surface-200 outline-none placeholder:font-medium placeholder:text-ink-300 focus:ring-2 focus:ring-accent-500"
          />
        </label>
        {error && <p className="rounded-2xl bg-danger-100 px-4 py-2.5 text-[13px] font-semibold text-danger-600">{error}</p>}
        <Button type="submit" disabled={busy} className="mt-2 w-full py-4 text-base">{busy ? 'Checking…' : 'Continue'}</Button>
      </form>
      <p className="mt-6 text-xs leading-relaxed text-ink-500">Use the same number the front desk noted when you checked in. If it does not work, please ask reception.</p>
    </main>
  )
}

function Ended({ reason, onAgain }: { reason?: string; onAgain: () => void }) {
  const moved = reason === 'room_transfer'
  return (
    <main className="grid min-h-dvh place-items-center bg-surface-100 px-6 text-center">
      <div className="max-w-sm rise-in">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-accent-100 text-accent-600"><CheckCircle2 className="size-8" /></div>
        <h1 className="text-xl font-bold text-ink-900">{moved ? 'You have moved rooms' : 'Your stay has ended'}</h1>
        <p className="mt-2 text-sm text-ink-500">
          {moved ? 'Sign in again with your new room number and the same mobile number.' : 'Thank you for staying with us. This page no longer works for that room.'}
        </p>
        <Button variant="ghost" className="mt-6 w-full" onClick={onAgain}>Sign in again</Button>
      </div>
    </main>
  )
}

/* -------------------------------- Home --------------------------------- */

type Tab = 'home' | 'requests' | 'info'

function Home({ uid, session, settings, onEnded, onLeave }: {
  uid: string; session: Session; settings: Settings
  onEnded: (reason?: string) => void; onLeave: () => void
}) {
  const [tab, setTab] = useState<Tab>('home')
  const [room, setRoom] = useState<Room | null>(null)
  const [requests, setRequests] = useState<GuestRequest[]>([])
  const [sheet, setSheet] = useState<Kind | null>(null)
  const [toast, showToast] = useToast()
  const [lastSentAt, setLastSentAt] = useState(0)
  const stayId = room?.active_bill_id ?? null

  useEffect(() => { touch(uid, settings.sessionHours) }, [uid, settings.sessionHours])

  useEffect(() => {
    const stopSession = watchSession(uid, (s) => {
      if (!s || s.status !== 'active') onEnded(s?.closedReason)
    }, () => onEnded('closed'))
    const stopRoom = watchRoom(session.room, (r) => {
      if (!r || r.status !== 'occupied' || !r.active_bill_id) { onEnded('closed'); return }
      setRoom(r)
    }, () => onEnded('closed'))
    return () => { stopSession(); stopRoom() }
  }, [uid, session.room, onEnded])

  useEffect(() => {
    if (!stayId) return
    return watchRequests(stayId, setRequests, () => onEnded('closed'))
  }, [stayId, onEnded])

  const kinds = useMemo(
    () => (Object.keys(KINDS) as Kind[]).filter((k) => settings.kinds?.[k] !== false),
    [settings.kinds],
  )
  const active = requests.filter((r) => r.active)
  const firstName = (room?.guest?.name ?? '').trim().split(/\s+/)[0] ?? ''

  async function send(kind: Kind, note: string) {
    const wait = MIN_GAP_MS - (Date.now() - lastSentAt)
    if (wait > 0) throw new Error(`Please wait ${Math.ceil(wait / 1000)}s before sending another request.`)
    if (!room) throw new Error('Still loading your room. Try again in a moment.')
    await sendRequest(uid, session, room, settings.sessionHours, kind, note)
    setLastSentAt(Date.now())
    setSheet(null)
    showToast('Sent. The front desk has been told.')
    setTab('requests')
  }

  return (
    <div className="flex min-h-dvh flex-col bg-surface-100">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-white/90 px-4 py-3 shadow-card backdrop-blur">
        <div>
          <Eyebrow>{settings.hotelName || 'Guest services'}</Eyebrow>
          <p className="text-base font-bold leading-tight text-ink-900">Room {session.room}</p>
        </div>
        {settings.receptionPhone && (
          <a
            href={'tel:' + settings.receptionPhone.replace(/[^\d+]/g, '')}
            className="flex items-center gap-1.5 rounded-full bg-accent-100 px-3 py-2 text-[12px] font-bold text-accent-700 active:scale-95"
          >
            <Phone className="size-3.5" /> Reception
          </a>
        )}
      </header>

      <main className="flex-1 px-4 pb-28 pt-4">
        {tab === 'home' && (
          <HomeTab
            firstName={firstName} room={room} settings={settings} kinds={kinds}
            activeCount={active.length} onPick={setSheet} onShowRequests={() => setTab('requests')} onCopied={showToast}
          />
        )}
        {tab === 'requests' && (
          <RequestsTab requests={requests} onCancel={async (id) => {
            try { await cancelRequest(id); showToast('Request cancelled.') }
            catch (e) { showToast(toGuestError(e).message) }
          }} />
        )}
        {tab === 'info' && (
          <InfoTab settings={settings} room={room} session={session} uid={uid} onLeave={onLeave} onToast={showToast} />
        )}
      </main>

      <Toast text={toast} />

      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-surface-200 bg-white pb-[env(safe-area-inset-bottom)]">
        <TabButton active={tab === 'home'} onClick={() => setTab('home')} icon={<Sparkles className="size-5" />} label="Services" />
        <TabButton active={tab === 'requests'} onClick={() => setTab('requests')} icon={<ListChecks className="size-5" />} label="My requests" badge={active.length} />
        <TabButton active={tab === 'info'} onClick={() => setTab('info')} icon={<Info className="size-5" />} label="Info" />
      </nav>

      {sheet && <RequestSheet kind={sheet} onClose={() => setSheet(null)} onSend={(note) => send(sheet, note)} />}
    </div>
  )
}

function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; badge?: number }) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn('relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-bold', active ? 'text-accent-600' : 'text-ink-500')}
    >
      {icon}
      {label}
      {badge ? <span className="absolute right-[22%] top-1 rounded-full bg-accent-600 px-1.5 text-[10px] font-bold text-white">{badge}</span> : null}
    </button>
  )
}

function HomeTab({ firstName, room, settings, kinds, activeCount, onPick, onShowRequests, onCopied }: {
  firstName: string; room: Room | null; settings: Settings; kinds: Kind[]; activeCount: number
  onPick: (k: Kind) => void; onShowRequests: () => void; onCopied: (t: string) => void
}) {
  const nights = nightsSince(room?.checkin_time)
  return (
    <div className="rise-in">
      <section className="rounded-3xl bg-gradient-to-br from-accent-600 to-accent-700 p-5 text-white shadow-lift">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/70">Good to have you</p>
        <h1 className="mt-1 text-2xl font-bold">{firstName ? `Hello, ${firstName}` : 'Hello'}</h1>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <StatPlain caption={nights === 0 ? 'checked in today' : 'with us'} value={room ? nightsLabel(nights) : '…'} />
          <StatPlain caption="Check-in" value={room?.checkin_time ? room.checkin_time.slice(11) : '…'} />
          <StatPlain caption="Checkout" value={settings.checkoutTime || '—'} />
        </div>
      </section>

      {(settings.wifiName || settings.whatsapp) && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {settings.wifiName && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(settings.wifiPassword || '').then(() => onCopied('Wi-Fi password copied'))
              }}
              className="rounded-2xl bg-white p-4 text-left shadow-card ring-1 ring-surface-200 active:scale-[0.98]"
            >
              <Wifi className="size-5 text-accent-600" />
              <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">Wi-Fi</p>
              <p className="truncate text-sm font-bold text-ink-900">{settings.wifiName}</p>
              {settings.wifiPassword && (
                <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-ink-700">{settings.wifiPassword} <Copy className="size-3 text-ink-300" /></p>
              )}
            </button>
          )}
          {settings.whatsapp && (
            <a
              href={'https://wa.me/' + settings.whatsapp.replace(/\D/g, '')}
              target="_blank" rel="noreferrer"
              className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-surface-200 active:scale-[0.98]"
            >
              <MessageCircle className="size-5 text-ok-600" />
              <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">WhatsApp</p>
              <p className="text-sm font-bold text-ink-900">Message reception</p>
            </a>
          )}
        </div>
      )}

      {activeCount > 0 && (
        <button type="button" onClick={onShowRequests} className="mt-3 flex w-full items-center justify-between rounded-2xl bg-accent-50 px-4 py-3 text-sm font-semibold text-accent-700 ring-1 ring-accent-100">
          <span>{activeCount} request{activeCount === 1 ? '' : 's'} in progress</span><span>View</span>
        </button>
      )}

      <h2 className="mb-3 mt-6 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">What do you need?</h2>
      <div className="grid grid-cols-2 gap-3">
        {kinds.map((k) => (
          <button
            key={k} type="button" onClick={() => onPick(k)}
            className="rounded-2xl bg-white p-4 text-left shadow-card ring-1 ring-surface-200 transition active:scale-[0.97]"
          >
            <span className="flex size-11 items-center justify-center rounded-xl bg-accent-100 text-accent-600">{ICONS[k]}</span>
            <p className="mt-3 text-sm font-bold text-ink-900">{KINDS[k].label}</p>
            <p className="mt-0.5 text-xs text-ink-500">{KINDS[k].blurb}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function nightsLabel(n: number): string {
  return n === 0 ? 'Day 1' : `Night ${n}`
}

function StatPlain({ caption, value }: { caption: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/15 px-2 py-3">
      <span className="text-xl font-bold">{value}</span>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-white/70">{caption}</p>
    </div>
  )
}

function RequestsTab({ requests, onCancel }: { requests: GuestRequest[]; onCancel: (id: string) => Promise<void> }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 30_000); return () => window.clearInterval(t) }, [])
  if (requests.length === 0) {
    return (
      <div className="rise-in grid place-items-center py-16 text-center">
        <span className="mb-3 flex size-14 items-center justify-center rounded-full bg-white text-ink-300 shadow-card"><ListChecks className="size-6" /></span>
        <p className="text-sm font-semibold text-ink-700">Nothing yet</p>
        <p className="mt-1 max-w-[240px] text-xs text-ink-500">Tap a service and the front desk is told straight away. You will see it move from Sent to Done here.</p>
      </div>
    )
  }
  return (
    <ul className="rise-in flex flex-col gap-3">
      {requests.map((r) => {
        const st = STATUS_META[r.status] ?? STATUS_META.open
        return (
          <li key={r.id} className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-surface-200">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-100 text-accent-600">{ICONS[r.kind] ?? <Bell className="size-5" />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-ink-900">{KINDS[r.kind]?.label ?? r.kind}</p>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', st.cls)}>{st.label}</span>
                </div>
                {r.note && <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-700">{r.note}</p>}
                <ol className="mt-3 flex flex-col gap-1.5 text-xs text-ink-500">
                  <Step done label={`Sent ${dayTime(r.createdAt, r.createdAtMs)}`} />
                  {r.status === 'cancelled' ? (
                    <Step done muted label={`Cancelled ${clock(r.cancelledAtMs)}`} />
                  ) : (
                    <>
                      <Step done={Boolean(r.acknowledgedAtMs)} label={r.acknowledgedAtMs ? `Seen by staff at ${clock(r.acknowledgedAtMs)} (${minutesBetween(r.createdAtMs, r.acknowledgedAtMs)})` : 'Waiting for staff to see it'} />
                      <Step done={Boolean(r.doneAtMs)} label={r.doneAtMs ? `Done at ${clock(r.doneAtMs)} (${minutesBetween(r.createdAtMs, r.doneAtMs)} in all)` : 'Being taken care of'} />
                    </>
                  )}
                </ol>
                {r.status === 'open' && (
                  <button type="button" onClick={() => void onCancel(r.id)} className="mt-3 text-xs font-bold text-danger-600">Cancel request</button>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Step({ done, label, muted }: { done: boolean; label: string; muted?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn('size-2 rounded-full', done ? (muted ? 'bg-ink-300' : 'bg-accent-600') : 'bg-surface-300')} />
      <span className={cn(done && !muted && 'text-ink-700')}>{label}</span>
    </li>
  )
}

function InfoTab({ settings, room, session, uid, onLeave, onToast }: {
  settings: Settings; room: Room | null; session: Session; uid: string; onLeave: () => void; onToast: (t: string) => void
}) {
  return (
    <div className="rise-in flex flex-col gap-3">
      <Card title="Your stay">
        <Row k="Room" v={session.room} />
        <Row k="Guest" v={room?.guest?.name ?? '…'} />
        <Row k="Checked in" v={room?.checkin_time ?? '…'} />
        <Row k="Checkout time" v={settings.checkoutTime || '—'} />
        {settings.receptionPhone && <Row k="Reception" v={settings.receptionPhone} />}
      </Card>
      {settings.houseRules && <Card title="House rules"><p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{settings.houseRules}</p></Card>}
      {settings.nearbyInfo && <Card title="Nearby & useful"><p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{settings.nearbyInfo}</p></Card>}
      {room && <RateCard uid={uid} session={session} room={room} onToast={onToast} />}
      <button type="button" onClick={onLeave} className="mt-2 flex items-center justify-center gap-2 py-3 text-xs font-bold text-ink-500">
        <LogOut className="size-4" /> Sign out on this phone
      </button>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-surface-200">
      <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-500">{title}</h2>
      {children}
    </section>
  )
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-t border-surface-200 py-2 text-sm first:border-t-0">
      <span className="text-ink-500">{k}</span><span className="text-right font-semibold text-ink-900">{v}</span>
    </div>
  )
}

function RateCard({ uid, session, room, onToast }: { uid: string; session: Session; room: Room; onToast: (t: string) => void }) {
  const [rated, setRated] = useState<boolean | null>(null)
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void readFeedback(room.active_bill_id ?? '').then(setRated) }, [room.active_bill_id])
  if (rated === null) return null
  if (rated) {
    return <Card title="Your rating"><p className="text-sm text-ink-700">Thank you for rating your stay.</p></Card>
  }
  async function submit() {
    if (!rating) return
    setBusy(true)
    try {
      await rateStay(uid, session, room, rating, comment)
      setRated(true)
      onToast('Thank you!')
    } catch (e) {
      onToast(toGuestError(e).message)
      setBusy(false)
    }
  }
  return (
    <Card title="How is your stay?">
      <div className="flex gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} star`} className="p-1 active:scale-90">
            <Star className={cn('size-8', n <= rating ? 'fill-warn-600 text-warn-600' : 'text-surface-300')} />
          </button>
        ))}
      </div>
      <textarea
        rows={2} maxLength={500} placeholder="Anything we should know? (optional)" value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="mt-3 w-full rounded-xl bg-surface-100 px-3 py-2.5 text-sm text-ink-900 outline-none ring-1 ring-surface-200 focus:ring-accent-500"
      />
      <Button className="mt-3 w-full" disabled={!rating || busy} onClick={() => void submit()}>Send rating</Button>
    </Card>
  )
}

/* ---------------------------- Request sheet ---------------------------- */

function RequestSheet({ kind, onClose, onSend }: { kind: Kind; onClose: () => void; onSend: (note: string) => Promise<void> }) {
  const meta = KINDS[kind]
  const [picked, setPicked] = useState<string[]>([])
  const [free, setFree] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const note = [...picked, free.trim()].filter(Boolean).join('\n')

  async function send() {
    setError('')
    if (meta.needsNote && !note) { setError(meta.chips.length ? 'Pick an option or write a line.' : 'Please write a line so we know what to look into.'); return }
    setBusy(true)
    try { await onSend(note) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send.'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink-900/50" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet-in mx-auto w-full max-w-md rounded-t-3xl bg-white px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-4 shadow-pop" role="dialog" aria-modal="true">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-surface-300" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-accent-100 text-accent-600">{ICONS[kind]}</span>
            <div>
              <h2 className="text-base font-bold text-ink-900">{meta.label}</h2>
              <p className="text-xs text-ink-500">{meta.blurb}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-ink-500 active:bg-surface-100"><X className="size-5" /></button>
        </div>
        {meta.chips.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {meta.chips.map((c) => {
              const on = picked.includes(c)
              return (
                <button
                  key={c} type="button"
                  onClick={() => setPicked(on ? picked.filter((p) => p !== c) : [...picked, c])}
                  className={cn('rounded-full px-3.5 py-2 text-[13px] font-semibold ring-1 transition active:scale-95',
                    on ? 'bg-accent-600 text-white ring-accent-600' : 'bg-white text-ink-700 ring-surface-300')}
                >
                  {c}
                </button>
              )
            })}
          </div>
        )}
        <textarea
          rows={3} maxLength={300} value={free} onChange={(e) => setFree(e.target.value)}
          placeholder={kind === 'complaint' ? 'Tell us what happened' : 'Anything else? (optional)'}
          className="mt-4 w-full rounded-2xl bg-surface-100 px-4 py-3 text-sm text-ink-900 outline-none ring-1 ring-surface-200 focus:ring-2 focus:ring-accent-500"
        />
        {error && <p className="mt-2 text-[13px] font-semibold text-danger-600">{error}</p>}
        <div className="mt-4 grid grid-cols-[auto_1fr] gap-3">
          <Button variant="ghost" onClick={onClose}><ChevronLeft className="size-4" /> Back</Button>
          <Button disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send to front desk'}</Button>
        </div>
      </div>
    </div>
  )
}
