// Anda — bottom navigation (PRD §6).
//
// Exactly three destinations: Home, Activity, Account. Room (code, members,
// leave) lives inside Account; financial detail is NOT a fourth tab — it is
// part of Account (PRD §27). Nothing may be added here.

import { NavLink, useParams } from 'react-router-dom';
import { Icon } from './Icon';

export function BottomNav() {
  const { roomId = '' } = useParams();
  const base = `/room/${roomId}`;

  const items = [
    { to: base, label: 'Home', icon: 'nest_cam_indoor', end: true },
    { to: `${base}/activity`, label: 'Activity', icon: 'history', end: false },
    { to: `${base}/account`, label: 'Account', icon: 'account_balance_wallet', end: false },
  ];

  return (
    <nav className="bottomnav" aria-label="Primary">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `bottomnav__item${isActive ? ' bottomnav__item--active' : ''}`
          }
        >
          {({ isActive }) => (
            <>
              <Icon name={item.icon} size={24} filled={isActive} weight={isActive ? 500 : 400} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
