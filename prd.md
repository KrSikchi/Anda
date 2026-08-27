**Product Requirements Document (PRD)**  

**Anda – Shared Egg Inventory &amp; Settlement Tracker**  

Version 1.0 | Confidential | Internal Use  

---

### 1. Executive Summary

Anda is a lightweight, privacy-first Progressive Web App (PWA) designed exclusively for small shared living groups (apartments, flatshares, hostels). It solves the everyday friction of tracking communal egg purchases, individual consumption, real-time stock levels, and fair cost settlement without requiring traditional user accounts, email verification, or complex tenancy management.

The product prioritizes:

- **Zero-friction identity** (device-bound pseudonymous membership)

- **Transactional integrity** (inventory derived from immutable ledger, never a mutable counter)

- **Live synchronization** across devices

- **Maximum uptime and operational simplicity** via managed infrastructure

- **Minimum error surface** through database-enforced constraints, atomic operations, and optimistic local persistence with server authority

Target users are 2–8 cohabitants who share grocery costs. Success is measured by near-zero manual reconciliation effort and near-100% data consistency even under intermittent connectivity.

---

### 2. Product Vision &amp; Goals

**Vision**  

A shared egg (and eventually grocery) ledger that “just works” — so simple that flatmates never need instructions, yet robust enough that money, history, and stock never become disputed.

**Primary Goals**

- Eliminate verbal “who used how many” arguments

- Maintain an auditable, correction-friendly ledger

- Deliver real-time visibility of current stock and per-person liability

- Support low-stock push alerts without accounts

- Operate with near-zero ongoing maintenance and high availability

**Non-Goals (MVP)**

- Multi-room / multi-tenancy complexity

- Full offline-first CRDT synchronization

- Complex role hierarchies or admin dashboards

- Integration with payment processors or grocery APIs

- Support for items beyond eggs (future extensibility only)

---

### 3. Target Users &amp; Use Cases

**Primary Persona**  

Young professionals / students sharing a flat (2–6 people). They buy eggs in bulk, consume them irregularly, and periodically settle costs. Internet is generally available but Wi-Fi can drop. They value speed and zero cognitive load over feature richness.

**Core Use Cases**

1. Create a room → receive shareable code

2. Join room with display name only

3. Record egg usage (optimistic UI + server confirmation)

4. Record purchases (quantity + cost)

5. View live inventory, per-member consumption, and replacement liability

6. Receive low-stock push notifications

7. Leave room while preserving historical contribution

8. Correct mistaken entries via compensating transactions

---

### 4. Functional Requirements

#### 4.1 Room Lifecycle

- Host creates room → system generates short alphanumeric code (e.g., `K7P4Q2`)

- Members join by entering code + display name

- System issues private `member_id` stored only on device (localStorage / IndexedDB)

- Host can regenerate code or soft-delete room

- Members can leave; historical usage remains in ledger

#### 4.2 Identity &amp; Authorization

- No email, password, OAuth, or traditional accounts

- Pseudonymous device-bound identity `member_id` + `room_id`)

- All writes scoped by Row Level Security (RLS): a member may only read/write data belonging to rooms they currently belong to

- Frontend is untrusted; every mutation is re-validated server-side

#### 4.3 Transactional Ledger (Core Data Model)

Primary entities:

- `rooms`

- `members` (with soft-delete / active flag)

- `purchases` (quantity, cost, timestamp, member_id)

- `egg_usage` (quantity, timestamp, member_id, optional correction_of)

- `settlements` (optional future)

**Inventory is never stored as a primary value.**  

Current stock = Σ purchases − Σ usage (including corrections).  

This design enables:

- Full audit trail

- Safe corrections without destructive edits

- Accurate historical liability even after members leave

#### 4.4 Real-time Synchronization

- Clients subscribe to room-scoped changes via Supabase Realtime

- On any purchase or usage insert, all connected clients receive the delta and recompute derived state

- Optimistic UI updates with clear sync status indicators (Synced / Syncing / Offline)

#### 4.5 Concurrency &amp; Integrity

- All stock-mutating operations execute inside PostgreSQL transactions

- Atomic check-and-write: reject any usage that would drive inventory negative

- Server remains the single source of truth; offline clients may optimistically decrement but must reconcile on reconnect

#### 4.6 Offline Behavior

- Local cache of room state, recent transactions, and pending actions (IndexedDB)

- Pending mutations queued and flushed when connectivity returns

- Clear visual status; never present unconfirmed local state as final

- MVP may optionally require connectivity for writes; full offline queue is a near-term enhancement

#### 4.7 Low-Stock Alerts

- Room-configurable threshold (default 10)

- Push notification triggered only on threshold crossing (not on every subsequent decrement)

- State flag `low_stock_notified` reset only after inventory rises above threshold again

- Notifications delivered via Web Push associated with device/member identity (no accounts required)

#### 4.8 Corrections &amp; Audit

- Mistaken usage is corrected by inserting a compensating negative usage record linked to the original

- Full history visible to room members

- No destructive updates to past transactions

---

### 5. Non-Functional Requirements

#### 5.1 Reliability &amp; Uptime

- Target: ≥ 99.9% monthly availability (~43 minutes downtime/month)

- Achieved via managed services (Supabase + edge hosting) rather than self-managed infrastructure

- Database backups, point-in-time recovery, and automatic failover provided by platform

- Frontend PWA shell remains loadable from cache during transient hosting outages; data operations gracefully degrade to offline mode

#### 5.2 Performance &amp; Efficiency

- Perceived latency for usage recording &lt; 200 ms (optimistic) / &lt; 800 ms (confirmed)

- Realtime propagation &lt; 1–2 seconds under normal conditions

- Minimal payload sizes; only room-scoped deltas transmitted

- Efficient recomputation of derived inventory on client

#### 5.3 Data Integrity &amp; Error Minimization

- Database constraints + RLS + transactional atomicity as primary defense

- No client-side authority over stock

- Explicit handling of race conditions and offline conflicts

- Comprehensive audit trail reduces dispute resolution time to near zero

#### 5.4 Security

- HTTPS everywhere

- No secrets in frontend

- RLS as authorization boundary

- Device-bound member tokens with rotation capability

- Soft-delete of members preserves history while removing write access

#### 5.5 Maintainability &amp; Operational Simplicity

- Zero servers to patch or scale

- Schema changes via migrations

- Observability through platform dashboards + structured logging

- Future extensibility prepared (additional grocery items, settlements, multi-currency) without rewriting core ledger model

---

### 6. Recommended Technology Stack

| Layer              | Technology                          | Rationale |

|--------------------|-------------------------------------|---------|

| Frontend           | React + TypeScript + Vite           | Type safety, fast iteration, excellent PWA tooling |

| PWA / Offline      | Workbox / Vite PWA plugin + IndexedDB | Reliable caching and background sync |

| Authentication     | Supabase Auth (anonymous / custom JWT) or pure custom member tokens | Zero-friction, no email required |

| Database           | PostgreSQL (via Supabase)           | ACID transactions, constraints, RLS, proven reliability |

| Realtime           | Supabase Realtime                   | Built-in, low operational overhead |

| API / Backend      | Supabase (PostgREST + Edge Functions if needed) | Eliminates custom backend for MVP |

| Hosting (Frontend) | Vercel / Cloudflare Pages           | Global edge, automatic HTTPS, high uptime |

| Push Notifications | Web Push + Supabase Edge Function or dedicated service | Account-less delivery |

| Local Persistence  | IndexedDB (via idb or Dexie)        | Pending queue + cache |

**Architectural Principle**  

Transactions are the source of truth; inventory is a derived, eventually consistent view. The database is the sole authority. The browser is untrusted.

---

### 7. High-Level Architecture

```

User Device (PWA)

├── Local cache + pending queue

├── Optimistic UI

└── Realtime subscription

         │

         ▼

Supabase

├── Auth / Member identity

├── PostgreSQL (RLS + transactions)

├── Realtime

└── Edge Functions (notifications, validation)

```

Data flow for usage:

1. Client optimistically updates local view and queues mutation

2. Mutation sent to Supabase

3. Server validates membership + available stock inside transaction

4. On success → Realtime broadcast → all clients update

5. On failure → client reverts optimistic state and surfaces error

---

### 8. Success Metrics (MVP)

- Time from “I used eggs” to confirmed ledger entry &lt; 1 s (online)

- Zero data-loss incidents under concurrent usage

- Inventory accuracy 100% after reconciliation

- Average session length and daily active members within room

- Support ticket volume related to “wrong stock” or “who owes what” near zero

- Uptime ≥ 99.9% measured at the database and realtime layers

---

### 9. Risks &amp; Mitigations

| Risk                              | Mitigation |

|-----------------------------------|----------|

| Race conditions on last eggs      | Atomic DB transactions |

| Offline over-consumption          | Server rejection + clear UI feedback on reconnect |

| Device loss / member_id loss      | Soft recovery flow (re-join with same name + host confirmation) |

| Notification spam                 | Threshold-crossing flag only |

| Future feature creep              | Strict MVP scope; ledger model already supports extension |

---

### 10. Future Considerations (Post-MVP)

- Multi-item grocery support (same ledger pattern)

- Settlement generation and payment status

- Optional email/magic-link for long-term member recovery

- Exportable CSV/PDF statements

- Basic analytics (consumption trends)

---

### 11. Conclusion

Anda deliberately rejects conventional account-heavy SaaS patterns in favor of a minimal, high-integrity design optimized for a very specific social context: trusted flatmates sharing a perishable staple.  

By making the transactional ledger the center of the system, enforcing correctness at the database layer, and leveraging managed infrastructure for realtime, auth, and uptime, the product achieves maximum reliability and minimum operational burden while remaining almost invisible in daily use.

The guiding principle remains:  

**If a flatmate needs instructions, the product is still too complicated.**

---

**Document Control**  

Prepared for internal product &amp; engineering alignment.  

Next review: after first internal pilot with 1–2 apartments.
