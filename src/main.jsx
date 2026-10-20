import React from 'react';
import ReactDOM from 'react-dom/client';
import UnlockGate from './UnlockGate.jsx';
import { sanitizeRendererError } from './lib/error-sanitizer.mjs';

class RendererErrorBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    const safe = sanitizeRendererError(error);
    console.error(`One Brain UI render failed: ${safe.name}: ${safe.message}`);
  }

  render() {
    if (this.state.failed) {
      return <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: 32, background: '#0b0f16', color: '#e8edf4', fontFamily: 'system-ui, sans-serif' }}>
        <h1>One Brain could not render</h1>
        <p>The renderer hit an error. A redacted message was logged for diagnosis. Check the terminal for its source location.</p>
      </main>;
    }
    return this.props.children;
  }
}

function PreloadFailureScreen() {
  return <main style={{ minHeight: '100vh', boxSizing: 'border-box', padding: 32, background: '#0b0f16', color: '#e8edf4', fontFamily: 'system-ui, sans-serif' }}>
    <h1>Preload failed</h1>
    <p>The secure One Brain bridge is unavailable (<code>window.brain</code> was not exposed). Restart the app; if this continues, check the terminal and lifecycle log for the preload error.</p>
  </main>;
}

const root = ReactDOM.createRoot(document.getElementById('root'));
const preloadReady = window.brain && typeof window.brain.getSecurityStartupState === 'function';
root.render(preloadReady ? (
  <React.StrictMode><RendererErrorBoundary><UnlockGate /></RendererErrorBoundary></React.StrictMode>
) : <PreloadFailureScreen />);
