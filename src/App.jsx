import { useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { PapersPage } from './pages/PapersPage.jsx';
import { PaperDetailPage } from './pages/PaperDetailPage.jsx';
import { ComparePage } from './pages/ComparePage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';

export default function App() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="app-shell">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="main-area">
        <div className="topbar">
          <button className="btn btn-icon" onClick={() => setMobileOpen(true)} aria-label="開啟選單">
            <Menu size={18} />
          </button>
          <strong>PaperLens</strong>
        </div>
        <div className="main-content">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<PapersPage />} />
              <Route path="/papers/:paperId" element={<PaperDetailPage />} />
              <Route path="/compare" element={<ComparePage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
