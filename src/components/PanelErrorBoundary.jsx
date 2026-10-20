import React from 'react';
import { sanitizeRendererError } from '../lib/error-sanitizer.mjs';

export default class PanelErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error: sanitizeRendererError(error) };
  }

  componentDidCatch(error) {
    const safe = sanitizeRendererError(error);
    console.error(`One Brain panel render failed: ${safe.name}: ${safe.message}`);
  }

  render() {
    if (this.state.error) return <section role="alert" className="panel-render-error">
      <h3>This panel could not render</h3>
      <p>{this.state.error.name}: {this.state.error.message}</p>
    </section>;
    return this.props.children;
  }
}
