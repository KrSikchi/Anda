# Anda — Identity Model & Authorization (PRD §4, §5, §21)

## Identity model

- **No conventional accounts**: no email, password, OAuth, verification, recovery, or profiles (PRD §4).
- **Pseudonymous, device-bound identity**: when a person joins a room the server issues a private `member_id` (`members.id`, a UUID) and binds it to the device via Supabase anonymous auth: `members.auth_user_id = auth.uid()` (migration 0001, decision D1).
- The anonymous session (a signed JWT + refresh token) lives only in browser storage on that device; `auth.uid()` is derived **server-side from the verified JWT**, never from client input.
- **Display name is not the identity** (§4). It is cosmetic and never authorizes anything; every RPC identifies the caller by `auth.uid()` alone.
- Users only ever see/interact with their **display name** and the room **code**; `member_id`/`auth_user_id` are internal.

## Issuance & recovery

| Scenario | Behavior |
|---|---|
| Create room | `create_room(room_name, display_name, threshold)` creates room **and** host membership; returns `member_id` to store locally (IndexedDB/localStorage; frontend phase). |
| Join room | `join_room(code, display_name)` issues a fresh `member_id` bound to `auth.uid()`; returns it. |
| Same device joins an active room again | Idempotent — returns the **existing** `member_id` (soft identity recovery, decision D10). |
| Device left, then joins again | Fresh active membership with a **new** `member_id`; prior history stays with the old (inactive) identity. |
| Device/browser data lost | The anonymous session is lost too ⇒ a new device identity; recovery = re-join with the room code (PRD §9 soft-recovery flow). |

## Authorization (server-side only, §5)

- **RLS = read boundary** (migration 0001): `SELECT` only for `authenticated` callers who are *active members of an active room* (`is_active_room_member`). Cross-room and inactive-member reads are denied (Phase 2 tests R2–R6).
- **No direct write path**: there are no `INSERT`/`UPDATE`/`DELETE` grants or policies on any table for API roles.
- **Every mutation is a SECURITY DEFINER function** that re-validates membership, room activeness, and (where required) host identity *inside the function*, since RLS does not apply to the definer. The browser is never trusted (Phase 3 tests T8/T10/T11/T13).
- Host powers are exactly PRD §3: create, regenerate room code, soft-delete room. Enforced by `regenerate_room_code`/`soft_delete_room` host checks; no other host powers exist.

## RPC catalog (Phase 3)

| RPC | Caller | Effect |
|---|---|---|
| `create_room(text, text, integer default 10)` | any signed-in device | creates room + host member; returns room + member identity |
| `join_room(text, text)` | any signed-in device | issues membership; returns room + member identity |
| `leave_room(uuid)` | active member | soft-deactivates membership; history preserved |
| `regenerate_room_code(uuid)` | active **host** | new 6-char code; old code invalid |
| `soft_delete_room(uuid)` | active **host** | room invisible to all; rows preserved |

Helpers (`current_member_id`, `generate_share_code`, `anda_rand_index36`) carry **no** API execution grants.

## Error-message convention (§24)

Every user-facing failure raises `'Anda: <plain message>'`. The frontend maps prefixes to friendly flatmate copy (technical details stay in logs). Catalog in migration 0002 header.