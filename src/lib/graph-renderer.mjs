export function safeCreateWebGLRenderer(Renderer, options) {
  try { return new Renderer(options); }
  catch { return null; }
}
