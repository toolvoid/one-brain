'use strict';

function handleAllWindowsClosed({ platform, isLocked, quit }) {
  if (platform !== 'darwin' && !isLocked()) quit();
}

module.exports = { handleAllWindowsClosed };
