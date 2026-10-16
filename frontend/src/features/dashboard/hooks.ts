import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError, get, post } from '@/lib/api'
import { onRealtimeStatus, realtimeStatus } from '@/lib/realtime'
import type { Customer, Dashboard, PaymentRow, Room, Tariff } from '@/lib/types'
import { toast } from '@/lib/ui'

export function useRealtimeLive() {
  const [s, setS] = useState(realtimeStatus())
  useEffect(() => { const off = onRealtimeStatus(setS); return () => { off() } }, [])
  return s === 'live'
}

export function useDashboard() {
  const live = useRealtimeLive()
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => get<Dashboard>('/api/v2/dashboard', undefined, signal),
    // Rooms stream in through the Firestore listener when live; the poll
    // then only refreshes money tiles and arrivals.
    refetchInterval: live ? 60_000 : 15_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  })
}

export function useTariffs() {
  return useQuery({
    queryKey: ['tariffs'],
    queryFn: () => get<{ tariffs: Record<string, Tariff> }>('/api/v2/rooms/tariffs').then((r) => r.tariffs),
    staleTime: Infinity,
  })
}

export function useStayHistory(room: Room | null) {
  return useQuery({
    queryKey: ['history', room?.id, room?.active_bill_id],
    enabled: !!room && room.status === 'occupied' && !!room.guest,
    queryFn: () => get<{ cash: PaymentRow[]; online: PaymentRow[]; refunds: PaymentRow[]; addons: PaymentRow[]; renewals: PaymentRow[]; shifts: PaymentRow[] }>(
      `/api/v2/rooms/${room!.id}/history`,
      { name: room!.guest!.name, checkin_time: room!.checkin_time, stay_id: room!.active_bill_id },
    ),
  })
}

export function useCustomer(mobile: string) {
  return useQuery({
    queryKey: ['customer', mobile],
    enabled: /^\d{10}$/.test(mobile),
    queryFn: async () => {
      try {
        return (await get<{ customer: Customer }>('/api/v2/customers/lookup', { mobile })).customer
      } catch (e) {
        if (e instanceof ApiError && /not found/i.test(e.message)) return null
        throw e
      }
    },
    staleTime: 60_000,
  })
}

export function useCustomerSuggest(prefix: string) {
  return useQuery({
    queryKey: ['customer-suggest', prefix],
    enabled: /^\d{4,9}$/.test(prefix),
    queryFn: () => get<{ customers: Customer[] }>('/api/v2/customers/suggest', { prefix }).then((r) => r.customers),
    staleTime: 30_000,
  })
}

/** POST a room action, toast the server message, refresh the board. */
export function useRoomAction<TBody>(path: (room: string) => string, opts?: { silent?: boolean }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ room, body }: { room: string; body: TBody }) =>
      post<{ success: boolean; message?: string; [k: string]: unknown }>(path(room), body),
    onSuccess: (data) => {
      if (!opts?.silent && data?.message) toast(String(data.message))
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      void qc.invalidateQueries({ queryKey: ['history'] })
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.duplicate) toast(e.message, 'info')
      else toast(e instanceof Error ? e.message : 'Action failed', 'error')
    },
  })
}
