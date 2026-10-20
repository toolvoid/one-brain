import React from 'react';
import ReactDOM from 'react-dom/client';
import UnlockGate from './UnlockGate.jsx';

class RendererErrorBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    console.error('One Brain UI render failed; details omitted.');
  }

  render() {
    if (this.state.failed) {
      return <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: 32, background: '#0b0f16', color: '#e8edf4', fontFamily: 'system-ui, sans-serif' }}>
        <h1>One Brain could not render</h1>
        <p>The renderer hit an error. Its message was omitted to protect local content. Check the terminal for a source file and line number.</p>
      </main>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RendererErrorBoundary><UnlockGate /></RendererErrorBoundary>
  </React.StrictMode>
);
