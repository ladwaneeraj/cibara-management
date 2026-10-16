import { Camera, CheckCircle2, ImagePlus, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button, Notice, Textarea } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { useAuth, useCan } from '@/lib/auth'
import { cls, duration, stamp } from '@/lib/format'
import type { Room } from '@/lib/types'
import { toast } from '@/lib/ui'
import { useRoomAction } from './hooks'
import { checklistFor, elapsedSince, photoKindsFor, photosRequired } from './roomState'

type Kind = 'washroom' | 'coffee' | 'bed'
type Photos = Partial<Record<Kind | `${Kind}_thumb`, string>>

const KIND_LABEL: Record<Kind, string> = { washroom: 'Washroom', coffee: 'Coffee maker', bed: 'Room / bed' }

/** Downscale on the device before upload (the old UI did the same, ~200 KB). */
async function compress(file: File, max: number, quality = 0.8): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not process photo'))), 'image/jpeg', quality))
}

async function uploadPhoto(room: string, kind: Kind, context: string, file: File) {
  const [photo, thumb] = await Promise.all([compress(file, 1600), compress(file, 320, 0.7)])
  const fd = new FormData()
  fd.set('kind', kind)
  fd.set('context', context)
  fd.set('photo', photo, `${kind}.jpg`)
  fd.set('thumb', thumb, `${kind}_t.jpg`)
  const send = () => fetch(`/api/v2/rooms/${room}/photos`, {
    method: 'POST', body: fd, headers: { Authorization: `Bearer ${useAuth.getState().token ?? ''}` }, credentials: 'same-origin',
  })
  let res = await send()
  if (res.status === 401 && (await useAuth.getState().refresh())) res = await send()
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) throw new ApiError(body.message || 'Upload failed', res.status, body)
  return body as { url: string; thumb?: string }
}

function PhotoGrid({ room, kinds, context, photos, setPhotos }: {
  room: string; kinds: Kind[]; context: string; photos: Photos; setPhotos: (p: Photos) => void
}) {
  const [busy, setBusy] = useState<Kind | null>(null)
  return (
    <div className="grid grid-cols-3 gap-2">
      {kinds.map((k) => (
        <label key={k} className={cls('relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border-2 border-dashed text-xs',
          photos[k] ? 'border-emerald-400' : 'border-slate-300 dark:border-white/15')}>
          {photos[`${k}_thumb`] || photos[k]
            ? <img src={photos[`${k}_thumb`] || photos[k]} alt={KIND_LABEL[k]} className="absolute inset-0 size-full object-cover" />
            : <>{busy === k ? <span className="animate-pulse">Uploading…</span> : <ImagePlus className="size-5 text-slate-400" />}<span className="text-slate-500">{KIND_LABEL[k]}</span></>}
          <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={`${KIND_LABEL[k]} photo`}
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setBusy(k)
              try {
                const r = await uploadPhoto(room, k, context, f)
                setPhotos({ ...photos, [k]: r.url, [`${k}_thumb`]: r.thumb || r.url })
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Upload failed', 'error')
              } finally {
                setBusy(null)
              }
            }} />
        </label>
      ))}
    </div>
  )
}

export function CleaningPanel({ room, uiConfig, onDone }: { room: Room; uiConfig: Record<string, boolean>; onDone: () => void }) {
  const role = useAuth((s) => s.user?.role) || 'housekeeping'
  const canClean = useCan('room.cleaning.complete')
  const canApprove = useCan('room.inspection.approve')
  const ready = room.cleaning_status === 'ready_to_inspect'
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<Photos>({})
  const cleaned = useRoomAction<object>((r) => `/api/v2/rooms/${r}/cleaned`)
  const approve = useRoomAction<object>((r) => `/api/v2/rooms/${r}/ready`)

  const step: 'cleaned' | 'ready' = canApprove ? 'ready' : 'cleaned'
  const needPhotos = photosRequired(room.id, role, uiConfig, step)
  const kinds = photoKindsFor(room.id)
  const missing = needPhotos ? kinds.filter((k) => !photos[k]) : []
  const list = checklistFor(room.id)
  const elapsed = elapsedSince(room.cleaning_start_time)

  const submit = async () => {
    const body: Record<string, unknown> = {}
    if (notes.trim()) body.notes = notes.trim()
    if (Object.keys(photos).length) body.photos = photos
    try {
      if (step === 'ready') await approve.mutateAsync({ room: room.id, body: { ...body, checklist: checks } })
      else await cleaned.mutateAsync({ room: room.id, body })
      onDone()
    } catch { /* toast shown */ }
  }

  return (
    <div className="space-y-5">
      <div className={cls('rounded-2xl p-4', ready ? 'bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200')}>
        <div className="flex items-center gap-2 font-semibold">{ready ? <ShieldCheck className="size-5" /> : <Sparkles className="size-5" />}{ready ? 'Cleaned — awaiting inspection' : 'Being cleaned'}</div>
        <div className="mt-1 text-sm opacity-80">Since {stamp(room.cleaning_start_time)}{elapsed != null ? ` · ${duration(elapsed)}` : ''}</div>
      </div>

      {step === 'cleaned' && ready && <Notice tone="blue">A manager will inspect and release this room.</Notice>}

      {((step === 'cleaned' && canClean && !ready) || step === 'ready') && (
        <>
          {step === 'ready' && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Inspection checklist</h3>
              <div className="space-y-1">
                {list.map((c) => (
                  <label key={c.key} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-slate-50 dark:hover:bg-white/5">
                    <input type="checkbox" className="size-4 accent-brand-600" checked={!!checks[c.key]} onChange={(e) => setChecks({ ...checks, [c.key]: e.target.checked })} />
                    <span className="text-sm">{c.label}</span>
                  </label>
                ))}
              </div>
            </section>
          )}
          {kinds.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Camera className="size-4" />Photos {needPhotos ? <span className="text-xs font-normal text-rose-600">required</span> : <span className="text-xs font-normal text-slate-500">optional</span>}</h3>
              <PhotoGrid room={room.id} kinds={kinds} context={step === 'ready' ? 'inspection' : 'cleaning'} photos={photos} setPhotos={setPhotos} />
            </section>
          )}
          <Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          <Button size="lg" className="w-full" variant={step === 'ready' ? 'success' : 'primary'} icon={<CheckCircle2 className="size-4" />}
            disabled={missing.length > 0} loading={cleaned.isPending || approve.isPending} onClick={submit}>
            {step === 'ready' ? 'Ready for next guest' : 'Mark as cleaned'}
          </Button>
          {missing.length > 0 && <p className="text-center text-xs text-slate-500">Add {missing.map((k) => KIND_LABEL[k].toLowerCase()).join(', ')} photo{missing.length > 1 ? 's' : ''} to continue.</p>}
        </>
      )}
    </div>
  )
}
