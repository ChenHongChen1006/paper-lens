import React from 'react';
import { AlertTriangle } from 'lucide-react';

// Catches render-time errors so one broken page/component doesn't take
// down the whole app. API/async errors are handled locally with try/catch
// in each page instead (this only guards against unexpected render bugs).
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // Intentionally no console.error with full error detail here beyond
    // the message — avoid ever dumping potentially large document/paper
    // text or API payloads to the console.
    console.warn('PaperLens 發生未預期的畫面錯誤：', error?.message || error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ margin: 24 }}>
          <div className="row" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={18} />
            <strong>這個頁面發生了未預期的錯誤</strong>
          </div>
          <p className="muted mt-1">{this.state.error?.message || String(this.state.error)}</p>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
            重試
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
