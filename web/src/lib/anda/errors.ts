// Anda — error classification (PRD §24, §39).
//
// Three questions the UI needs answered about a failed call, and only the
// server can answer them honestly:
//
//   1. Did the server REFUSE the operation?          → surface it, never retry
//   2. Is this room gone for us?                     → leave the room
//   3. Did our session die?                          → ask the user to sign in
//
// Everything else is treated as a connectivity problem and queued.
// No raw database or auth text ever reaches a flatmate.

/** The server refused the write on its own authority (ledger/membership rules). */
export function isValidationError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not enough eggs remaining') ||
    m.includes('not a member of this room') ||
    m.includes('usage not found') ||
    m.includes('already been corrected') ||
    m.includes('corrected amount') ||
    m.includes('quantity must be') ||
    m.includes('price per egg cannot be') ||
    m.includes('total cost cannot be') ||
    m.includes('room not found') ||
    m.includes('nothing left to settle') ||
    m.includes('more than you owe') ||
    m.includes('not in this room') ||
    m.includes('choose a flatmate') ||
    m.includes('more than zero')
  );
}

/**
 * The room is gone for this device: soft-deleted, or we are no longer a
 * member. Distinct from being offline — reaching the server is what told us.
 */
export function isRoomUnavailableError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('not a member of this room') || m.includes('room not found');
}

/** The JWT is dead or was never there. Retrying or queueing will not help. */
export function isSessionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('jwt expired') ||
    m.includes('jwt is invalid') ||
    m.includes('invalid jwt') ||
    m.includes('refresh_token_not_found') ||
    m.includes('refresh token not found') ||
    m.includes('auth session missing') ||
    m.includes('user not authenticated') ||
    m.includes('not signed in')
  );
}

/** Plain-language copy for anything a flatmate might see (PRD §39). */
export function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (isSessionError(m)) {
    return 'Your session ended. Sign in again to keep your history.';
  }
  if (m.includes('not a member of this room') || m.includes('room not found')) {
    return 'This room is no longer available.';
  }
  if (m.includes('not enough eggs remaining')) {
    return 'Not enough eggs left — someone got there first.';
  }
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network')) {
    return 'No connection. Check your internet and try again.';
  }
  if (m.includes('quantity must be')) return 'Enter a quantity of at least one egg.';
  if (m.includes('price per egg cannot be')) return 'The price per egg cannot be negative.';
  if (m.includes('more than you owe')) return 'That is more than you owe.';
  if (m.includes('nothing left to settle')) return 'Nothing left to settle.';
  return message || 'Something went wrong. Try again.';
}
