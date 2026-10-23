import React from 'react';

export function SidebarToggle({ IconButton, collapsed, onToggle }) {
  const label = collapsed ? 'Show sidebar' : 'Collapse sidebar';
  return React.createElement('div', { className: 'sidebar-toggle-container' },
    React.createElement(IconButton, {
      type: 'button',
      className: 'sidebar-toggle-button',
      label,
      icon: collapsed ? 'chevron-right' : 'chevron-left',
      onClick: onToggle,
      'aria-expanded': !collapsed,
      'aria-keyshortcuts': 'Control+B'
    })
  );
}
