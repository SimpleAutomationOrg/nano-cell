// Long polls that only run while the tab is on screen.
//
// A browser allows six connections to one server, shared by ALL its tabs.
// Each viewer tab holds two long polls (live reload, chat); three tabs left
// open in the background used up all six, and every other request — a
// step file, a save — waited up to 25 s for one to come free. So a hidden
// tab drops its polls at once and takes them up again when it is shown.

const visible = () => typeof document === 'undefined' || !document.hidden;

function whenVisible() {
  if (visible()) return Promise.resolve();
  return new Promise(res => {
    const on = () => { if (visible()) { document.removeEventListener('visibilitychange', on); res(); } };
    document.addEventListener('visibilitychange', on);
  });
}

/**
 * fetch(url, init) for a long poll: waits until the tab is visible, and
 * gives up the connection the moment the tab is hidden — or when
 * `init.signal`, the caller's own way to drop the poll, fires. Resolves to the
 * Response, or to null when the poll was dropped that way (just call
 * again — it will wait for the tab to come back).
 */
export async function pollFetch(url, init = {}) {
  await whenVisible();
  const ctl = new AbortController();
  const hide = () => { if (!visible()) ctl.abort(); };
  const drop = () => ctl.abort();
  if (init.signal?.aborted) return null;
  init.signal?.addEventListener('abort', drop);
  document.addEventListener('visibilitychange', hide);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) return null;
    throw e;
  } finally {
    document.removeEventListener('visibilitychange', hide);
    init.signal?.removeEventListener('abort', drop);
  }
}
