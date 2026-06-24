// Opens (or focuses) a separate desktop window that renders the timeline only.
// Desktop-only — relies on Tauri's multi-window support.

const TIMELINE_LABEL = 'timeline';

export async function openTimelineWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

  // If it already exists, just focus it.
  const existing = await WebviewWindow.getByLabel(TIMELINE_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const win = new WebviewWindow(TIMELINE_LABEL, {
    url: 'index.html?view=timeline',
    title: 'Timeline',
    width: 1100,
    height: 420,
    minWidth: 560,
    minHeight: 320,
    resizable: true,
  });

  win.once('tauri://error', (e) => {
    console.error('Failed to open timeline window:', e);
  });
}

export async function closeTimelineWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(TIMELINE_LABEL);
  if (existing) await existing.close();
}

// True when THIS window is the popped-out timeline view.
export function isTimelineView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'timeline';
}
