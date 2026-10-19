/**
 * Guest footfall map. A Leaflet map with one circle per resolved pincode,
 * sized by guest count — a geographic "heat" view of where guests come from.
 * Uses vector circleMarkers (no marker-icon assets) and OSM tiles (allowed by
 * the classic CSP that serves /analytics).
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import type { GeoPoint } from './types'

export function GeoHeat({ points, height = 380 }: { points: GeoPoint[]; height?: number }) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  // Create the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    const map = L.map(elRef.current, { scrollWheelZoom: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    map.setView([15.3173, 75.7139], 6) // Karnataka, a sensible default centre
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null; layerRef.current = null }
  }, [])

  // Redraw the circles whenever the points change.
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    if (!pts.length) return
    const max = Math.max(...pts.map((p) => p.guests || 0), 1)
    const bounds: [number, number][] = []
    for (const p of pts) {
      const radius = 6 + 20 * Math.sqrt((p.guests || 0) / max)
      L.circleMarker([p.lat, p.lon], { radius, color: '#1d4ed8', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.5 })
        .bindTooltip(`${p.place || p.pincode} — ${p.guests} guest${p.guests === 1 ? '' : 's'}`)
        .addTo(layer)
      bounds.push([p.lat, p.lon])
    }
    map.invalidateSize()
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 })
  }, [points])

  return <div ref={elRef} className="relative z-0 overflow-hidden rounded-lg" style={{ height, width: '100%' }} />
}
