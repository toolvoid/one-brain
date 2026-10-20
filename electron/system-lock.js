'use strict';

function attachSystemLockEvents(powerMonitor, lock) {
  const suspend = () => lock('suspend');
  powerMonitor.on('suspend', suspend);
  powerMonitor.on('lock-screen', suspend);
  return () => {
    powerMonitor.removeListener?.('suspend', suspend);
    powerMonitor.removeListener?.('lock-screen', suspend);
  };
}

module.exports = { attachSystemLockEvents };
