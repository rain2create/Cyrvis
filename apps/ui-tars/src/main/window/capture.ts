import { BrowserWindow } from 'electron';

let depth = 0;
const hidden = new Set<CaptureWindow>();
export const assistantCaptureActive = () => depth > 0;
type CaptureWindow = Pick<
  BrowserWindow,
  | 'isDestroyed'
  | 'isVisible'
  | 'isAlwaysOnTop'
  | 'getTitle'
  | 'hide'
  | 'showInactive'
>;

/** Remove our own speech bubbles/eye highlights from a model screenshot. */
export async function withoutAssistantOverlays<T>(
  capture: () => Promise<T>,
  windows: CaptureWindow[] = BrowserWindow.getAllWindows(),
): Promise<T> {
  const visible = windows.filter(
    (win) =>
      !win.isDestroyed() &&
      win.isVisible() &&
      (win.isAlwaysOnTop() ||
        /CYRVIS Gaze Cursor|Cyrvis Companion/i.test(win.getTitle())),
  );
  depth++;
  visible.forEach((win) => {
    hidden.add(win);
    win.hide();
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 65));
    return await capture();
  } finally {
    depth--;
    if (!depth) {
      const restore = [...hidden];
      hidden.clear();
      restore.forEach((win) => {
        if (!win.isDestroyed()) win.showInactive();
      });
    }
  }
}
