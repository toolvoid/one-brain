export function sanitizeRendererError(error) {
  const name = String(error?.name || 'Error').replace(/[^\w.$-]/g, '').slice(0, 60) || 'Error';
  const message = String(error?.message || 'Unknown render error')
    .replace(/\b(pair(?:ing)?[\s_-]*code)\b\s*[:=]\s*[^\s,;&]+/gi, '$1=[REDACTED]')
    .replace(/\b(pair(?:ing)?[\s_-]*code)\b\s+[^\s,;&]+/gi, '$1 [REDACTED]')
    .replace(/\b(password|passphrase|token|key|api[_ -]?key|secret|private[_ -]?key)\b\s*[:=]\s*[^\s,;&]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;&]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]')
    .slice(0, 200);
  return { name, message: message || 'Unknown render error' };
}
