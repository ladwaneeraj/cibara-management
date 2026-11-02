// Shared empty-state block for the island (list, calendar, timeline). Matches
// the loading/error states in BookingsApp via the .bki-state class.
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="bki-state" role="status">
      <i className="fas fa-calendar-day bki-state-icon" aria-hidden="true" />
      <p className="bki-state-title">{message}</p>
      <p className="bki-state-hint">Try a different filter, or add a booking.</p>
    </div>
  )
}
