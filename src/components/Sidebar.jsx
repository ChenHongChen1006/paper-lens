import { NavLink } from 'react-router-dom';
import { FileText, GitCompare, Settings, X } from 'lucide-react';

const NAV_ITEMS = [
  { to: '/', label: '論文', icon: FileText, end: true },
  { to: '/compare', label: '跨篇比較', icon: GitCompare },
  { to: '/settings', label: '設定', icon: Settings },
];

export function Sidebar({ mobileOpen, onClose }) {
  return (
    <>
      {mobileOpen && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-brand row-between">
          <div>
            <div className="sidebar-brand-title">PaperLens</div>
            <div className="sidebar-brand-subtitle">文獻閱讀與原文核對工作台</div>
          </div>
          {mobileOpen && (
            <button className="modal-close" onClick={onClose} aria-label="關閉選單">
              <X size={18} />
            </button>
          )}
        </div>
        <nav className="stack" style={{ gap: 2 }}>
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onClose}
              className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}
