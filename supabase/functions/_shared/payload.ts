// Anda — low-stock notification payload (PRD §16, §24).
// Friendly, flatmate-readable copy; technical details never leave logs.

export interface LowStockPayload {
  title: string;
  body: string;
  tag: string;
  data: { type: 'low-stock' };
}

export function buildLowStockPayload(inventory: number, roomName: string): LowStockPayload {
  const body =
    inventory <= 0
      ? 'All eggs are gone — time to restock.'
      : `${inventory} egg${inventory === 1 ? '' : 's'} left — time to restock.`;
  return {
    title: `${roomName} · low on eggs`,
    body,
    // tag de-duplicates concurrent deliveries of the same episode.
    tag: 'anda-low-stock',
    data: { type: 'low-stock' },
  };
}