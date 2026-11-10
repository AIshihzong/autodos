// Runs in the board window before the page loads. Gives the web UI the same `window.autodos`
// object the Electron shell used to expose, plus title-bar dragging and outside-link handling.
(() => {
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return;
  const call = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const platform = navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux';

  window.autodos = {
    desktop: true,
    platform,
    pickFolder: () => call('pick_folder'),
    notify: (title, body) => call('notify', { title, body }),
    setBadge: (count) => call('set_badge', { count }),
    openExternal: (url) => call('open_external', { url }),
  };

  // Links to other sites open in the default browser, never inside the app.
  const outside = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.origin !== location.origin && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch {
      return null;
    }
  };
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target instanceof Element && e.target.closest('a[href]');
      const url = a && outside(a.getAttribute('href'));
      if (url) (e.preventDefault(), call('open_external', { url }));
    },
    true,
  );
  window.open = (href) => {
    const url = outside(String(href || ''));
    if (url) call('open_external', { url });
    return null;
  };

  // The macOS title bar is hidden; the rail and page headers act as it.
  if (platform === 'darwin') {
    const DRAG = '.panel-head, .page-head, .rail';
    const NO_DRAG = 'button, input, select, textarea, a, label, .seg, [role="tab"], [contenteditable]';
    const onBar = (e) => e.target instanceof Element && e.target.closest(DRAG) && !e.target.closest(NO_DRAG);
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail === 1 && onBar(e)) call('start_drag');
    });
    document.addEventListener('dblclick', (e) => onBar(e) && call('toggle_maximize'));
  }
})();
