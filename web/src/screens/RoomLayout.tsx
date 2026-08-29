// Anda — in-room shell. Owns the room guard and the three-destination
// bottom navigation (PRD §6, §9). Nothing else may live in that bar.

import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../session/SessionProvider';
import { BottomNav } from '../components/BottomNav';
import { Loading } from '../components/ui';

export function RoomLayout() {
  const { identity, booting } = useSession();

  if (booting) {
    return (
      <div className="screen">
        <Loading label="Opening Anda…" />
      </div>
    );
  }

  if (!identity) return <Navigate to="/" replace />;

  return (
    <>
      <Outlet />
      <BottomNav />
    </>
  );
}
