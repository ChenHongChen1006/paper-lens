import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { requestPersistentStorage } from './lib/storage.js';
import './styles.css';

// Best-effort: ask the browser not to silently evict this origin's
// IndexedDB under storage pressure. Fire-and-forget — never blocks
// rendering, and does nothing destructive either way. See storage.js.
requestPersistentStorage();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
