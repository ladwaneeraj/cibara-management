import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Generic centered modal, portaled to <body>. Backdrop click closes.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return createPortal(
    <div className="bki-portal">
      <div className="bki-modal-backdrop" onClick={onClose} />
      <div className="bki-modal" role="dialog" aria-label={title} aria-modal="true">
        <header className="bki-modal-head">
          <h3>{title}</h3>
          <button type="button" className="bki-drawer-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bki-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
