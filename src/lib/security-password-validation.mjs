const countCharacters = (value) => Array.from(String(value ?? '')).length;

export function validateSecurityPasswordForm({ mode, oldPassword = '', password = '', confirmPassword = '', typedConfirmation = '' }) {
  const errors = {};
  const needsNewPassword = mode === 'set' || mode === 'change';
  if (mode === 'change' && !oldPassword) errors.currentPassword = 'Enter your current password.';
  if (needsNewPassword && countCharacters(password) < 12) errors.newPassword = 'New password must contain at least 12 characters.';
  if (needsNewPassword && !confirmPassword) errors.confirmPassword = 'Confirm your new password.';
  else if (needsNewPassword && password !== confirmPassword) errors.confirmPassword = 'Confirm password does not match.';
  if (['export', 'restore', 'delete-backups'].includes(mode) && !password) errors.currentPassword = 'Enter the password.';
  if (mode === 'delete-backups' && typedConfirmation !== 'DELETE OLD BACKUPS') errors.typedConfirmation = 'Type DELETE OLD BACKUPS exactly to confirm.';
  return { errors, canSubmit: Object.keys(errors).length === 0, newPasswordCharacters: countCharacters(password) };
}
