'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
let validateSecurityPasswordForm;
test.before(async () => { ({ validateSecurityPasswordForm } = await import('../src/lib/security-password-validation.mjs')); });

test('new password validation counts characters, accepts 12 including spaces and unicode, and never length-checks old password', () => {
  const short = validateSecurityPasswordForm({ mode: 'change', oldPassword: 'x', password: '12345678901', confirmPassword: '12345678901' });
  assert.equal(short.newPasswordCharacters, 11);
  assert.equal(short.errors.newPassword.includes('12 characters'), true);
  assert.equal(short.canSubmit, false);

  const valid = validateSecurityPasswordForm({ mode: 'change', oldPassword: 'x', password: ' 1234567890 ', confirmPassword: ' 1234567890 ' });
  assert.equal(valid.newPasswordCharacters, 12);
  assert.deepEqual(valid.errors, {});
  assert.equal(valid.canSubmit, true);

  const unicode = validateSecurityPasswordForm({ mode: 'change', oldPassword: 'x', password: '😀'.repeat(12), confirmPassword: '😀'.repeat(12) });
  assert.equal(unicode.newPasswordCharacters, 12);
  assert.equal(unicode.canSubmit, true);
});

test('confirmation mismatch is a distinct field error', () => {
  const result = validateSecurityPasswordForm({ mode: 'change', oldPassword: 'current', password: 'abcdefghijkl', confirmPassword: 'abcdefghijkm' });
  assert.deepEqual(result.errors, { confirmPassword: 'Confirm password does not match.' });
  assert.equal(result.canSubmit, false);
});
