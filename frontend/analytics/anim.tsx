/**
 * Lightweight, dependency-free motion for the analytics page.
 *
 *  - <Reveal>  : fades + lifts its children in when they scroll into view,
 *                with an optional stagger delay.
 *  - useCountUp: animates a number from its previous value to the next one.
 *  - <Money/Count/Pct> : count-up aware formatters for KPI values.
 *
 * Everything respects `prefers-reduced-motion`: it renders the final state
 * immediately and runs no animation.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { count, money } from '@/lib/format'

const prefersReduced = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

/** Animation is possible only with a frame scheduler and a visible tab. */
const canAnimate = () =>
  !prefersReduced() &&
  typeof requestAnimationFrame !== 'undefined' &&
  !(typeof document !== 'undefined' && document.hidden)

/** Fade + slide a block in the first time it enters the viewport. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(() => prefersReduced() || typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    // No animation when reduced-motion is on, or where IntersectionObserver is
    // unavailable (jsdom/tests, very old browsers): show the content outright.
    if (prefersReduced() || typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { setShown(true); io.disconnect() } }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.04 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(22px) scale(.985)',
        transition: `opacity .6s ease ${delay}ms, transform .7s cubic-bezier(.22,1,.36,1) ${delay}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  )
}

/** Eased count-up to `target`. Re-animates from the last value whenever it changes. */
function useCountUp(target: number, ms = 1000): number {
  const safe = Number.isFinite(target) ? target : 0
  const [value, setValue] = useState(() => (canAnimate() ? 0 : safe))
  const fromRef = useRef(0)

  useEffect(() => {
    // No animation (reduced motion, hidden tab where rAF is paused, or no frame
    // scheduler, e.g. tests): jump straight to the final value.
    if (!canAnimate()) { setValue(safe); fromRef.current = safe; return }

    const start = performance.now()
    const a = fromRef.current
    let raf = 0
    const settle = () => { setValue(safe); fromRef.current = safe }
    // Safety net: rAF can be throttled/paused if the tab is backgrounded
    // mid-animation; this still lands on the final value.
    const safety = setTimeout(settle, ms + 400)
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(a + (safe - a) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else { fromRef.current = safe }
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); clearTimeout(safety) }
  }, [safe, ms])

  return value
}

/** ₹ amount that counts up. */
export function Money({ value }: { value: number }) {
  return <>{money(useCountUp(value))}</>
}

/** Plain integer that counts up. */
export function Count({ value }: { value: number }) {
  return <>{count(Math.round(useCountUp(value)))}</>
}

/** Percentage that counts up (one decimal, no trailing ".0"). */
export function Pct({ value }: { value: number }) {
  const v = useCountUp(value)
  return <>{`${Number(v.toFixed(1))}%`}</>
}
