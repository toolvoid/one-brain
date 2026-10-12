'use strict';

(function (root) {
  const definitions = {
    unknown_token: { label: 'Unknown token', hint: 'Fix: pair again.' },
    revoked: { label: 'Revoked', hint: 'Fix: token was revoked in the app; pair again.' },
    origin_mismatch: { label: 'Origin mismatch', hint: 'Fix: origin changed: unpair and pair again.' },
    pending_approval: { label: 'Paired, waiting for approval in One Brain', hint: null },
    blocked: { label: 'Blocked in One Brain', hint: null },
    rate_limited: { label: 'Rate limited', hint: 'Fix: wait a minute, then try again.' }
  };

  function authReasonDisplay(reason, site) {
    const value = definitions[reason];
    if (!value) return null;
    const client = `ext:${site}`;
    const hint = reason === 'pending_approval'
      ? `Fix: approve ${client} in One Brain -> Connected AIs.`
      : reason === 'blocked'
        ? `Fix: review ${client} in One Brain -> Connected AIs.`
        : value.hint;
    return { label: value.label, hint };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { authReasonDisplay };
  else root.OneBrainAuthReasons = { authReasonDisplay };
})(globalThis);
