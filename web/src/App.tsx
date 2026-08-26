// Anda — minimal app shell (Phase 9 refines UX; this is the installable PWA
// placeholder so the Phase-1 foundation exists before screens are built).

const styles: Record<string, React.CSSProperties> = {
  root: {
    maxWidth: 480,
    margin: '0 auto',
    padding: '24px 16px',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    color: '#2d2317',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 28,
    fontWeight: 700,
  },
  egg: { fontSize: 26 },
  tagline: { color: '#7a6a52', margin: '4px 0 24px' },
  card: {
    background: '#fffdf5',
    border: '1px solid #f0e6d2',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  muted: { color: '#a08b6b', fontSize: 13 },
};

export function App() {
  return (
    <main style={styles.root}>
      <div style={styles.brand}>
        <span style={styles.egg}>🥚</span> Anda
      </div>
      <p style={styles.tagline}>The shared egg ledger for your flat.</p>
      <div style={styles.card}>
        <p style={{ margin: 0 }}>
          Screens (join room, egg counter, purchase, history) land in Phase 9.
        </p>
        <p style={styles.muted}>Realtime store + backend gates validated through Phase 5/6.</p>
      </div>
    </main>
  );
}