'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authReasonDisplay } = require('../extension/src/auth-reasons');

test('popup maps each server reason to clear text and a site-specific fix', () => {
  assert.deepEqual(authReasonDisplay('unknown_token', 'claude'), { label: 'Unknown token', hint: 'Fix: pair again.' });
  assert.deepEqual(authReasonDisplay('revoked', 'claude'), { label: 'Revoked', hint: 'Fix: token was revoked in the app; pair again.' });
  assert.deepEqual(authReasonDisplay('origin_mismatch', 'claude'), { label: 'Origin mismatch', hint: 'Fix: origin changed: unpair and pair again.' });
  assert.deepEqual(authReasonDisplay('pending_approval', 'claude'), { label: 'Paired, waiting for approval in One Brain', hint: 'Fix: approve ext:claude in One Brain -> Connected AIs.' });
  assert.deepEqual(authReasonDisplay('blocked', 'claude'), { label: 'Blocked in One Brain', hint: 'Fix: review ext:claude in One Brain -> Connected AIs.' });
  assert.deepEqual(authReasonDisplay('rate_limited', 'claude'), { label: 'Rate limited', hint: 'Fix: wait a minute, then try again.' });
  assert.equal(authReasonDisplay('other', 'claude'), null);
});
