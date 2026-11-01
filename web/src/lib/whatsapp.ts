// Phone normalization mirrors booking.js (strip a leading 0, ensure the 91
// country code). buildWhatsappUrl opens the guest's chat with a prefilled
// message — it never auto-sends; the operator taps send.
export function normalizePhone(raw: string): string {
  let p = String(raw || '').replace(/\D/g, '')
  if (p.startsWith('0')) p = p.slice(1)
  if (!p.startsWith('91')) p = '91' + p
  return p
}

export function buildWhatsappUrl(mobile: string, text: string): string {
  return `https://wa.me/${normalizePhone(mobile)}?text=${encodeURIComponent(text)}`
}
