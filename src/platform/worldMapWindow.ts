// Opens (or focuses) a separate desktop window that renders the world map editor.
// Desktop-only — relies on Tauri's multi-window support.

const WORLDMAP_LABEL = 'worldmap';

export async function openWorldMapWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

  const existing = await WebviewWindow.getByLabel(WORLDMAP_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const win = new WebviewWindow(WORLDMAP_LABEL, {
    url: 'index.html?view=worldmap',
    title: 'World Map',
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
  });

  win.once('tauri://error', (e) => {
    console.error('Failed to open world map window:', e);
  });
}

export async function closeWorldMapWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const existing = await WebviewWindow.getByLabel(WORLDMAP_LABEL);
  if (existing) await existing.close();
}

// True when THIS window is the popped-out world map view.
export function isWorldMapView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'worldmap';
}

// Bring the main app window to the front (e.g. after "Read more" navigates to a doc there).
export async function focusMainWindow(): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const main = await WebviewWindow.getByLabel('main');
  if (!main) return;
  try {
    await main.unminimize();
  } catch {
    // not minimized — ignore
  }
  await main.setFocus();
}
