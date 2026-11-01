export function EmptyState({ message }: { message: string }) {
  return (
    <div className="empty-state bki-empty">
      <i className="fas fa-calendar-alt fa-3x" aria-hidden="true" />
      <p>{message}</p>
    </div>
  )
}
