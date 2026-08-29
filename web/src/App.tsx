// Anda — application shell and route table (PRD §9).
//
//   /                        landing / entry
//   /create-room             create a room
//   /join-room               join with a code
//   /sign-in                 optional email/password persistence
//   /room/:roomId            Home      (count, Eat, Buy)
//   /room/:roomId/activity   Activity  (the ledger)
//   /room/:roomId/account    Account   (identity, money, settlement, room)

import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session/SessionProvider';
import { Landing } from './screens/Landing';
import { CreateRoom } from './screens/CreateRoom';
import { JoinRoom } from './screens/JoinRoom';
import { SignIn } from './screens/SignIn';
import { RoomLayout } from './screens/RoomLayout';
import { Home } from './screens/Home';
import { Activity } from './screens/Activity';
import { Account } from './screens/Account';
import { Banner } from './components/ui';

export default function App() {
  return (
    <SessionProvider>
      <div className="app">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/create-room" element={<CreateRoom />} />
          <Route path="/join-room" element={<JoinRoom />} />
          <Route path="/sign-in" element={<SignIn />} />

          <Route path="/room/:roomId" element={<RoomLayout />}>
            <Route index element={<Home />} />
            <Route path="activity" element={<Activity />} />
            <Route path="account" element={<Account />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </SessionProvider>
  );
}

/** Shown while Supabase is unreachable but the local cache is usable. */
export function OfflineNotice() {
  const { store } = useSession();
  if (!store || store.status !== 'offline') return null;
  return (
    <div style={{ padding: '0 16px 12px' }}>
      <Banner tone="info" icon="cloud_off">
        Offline — showing the last saved state.
      </Banner>
    </div>
  );
}
