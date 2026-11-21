import path from 'node:path';
import { assistantCaptureActive } from './capture';
import {
  BrowserWindow,
  app,
  ipcMain,
  Menu,
  screen,
  type Rectangle,
} from 'electron';
import { getCompanionStore } from '@main/store/companion';
import { companionSkins, resolveCompanionSkin } from '@shared/companion-skins';
import * as env from '@main/env';
import { windowManager } from '@main/services/windowManager';
import { showWindow, sendCompanionCommand } from './index';
import {
  COMPANION_TASK_EXIT_MS,
  companionBounds,
  hasCompanionConversation,
  hasCompanionTasks,
  type CompanionSnapshot,
  type CompanionTask,
} from '@shared/companion';

let companionWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let quitting = false;
let positionStore: ReturnType<typeof getCompanionStore>;
let snapshot: CompanionSnapshot = {
  state: 'idle',
  micReady: false,
  error: null,
};
let drag: {
  cursor: { x: number; y: number };
  bounds: Rectangle;
  moved: boolean;
} | null = null;
let dragTimer: ReturnType<typeof setInterval> | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function clampPosition(position: { x: number; y: number }) {
  const area = screen.getDisplayNearestPoint(position).workArea;
  const [width, height] = companionWindow?.getSize() ?? [260, 320];
  return {
    x: Math.round(
      Math.min(
        Math.max(position.x, area.x),
        area.x + Math.max(0, area.width - width),
      ),
    ),
    y: Math.round(
      Math.min(
        Math.max(position.y, area.y),
        area.y + Math.max(0, area.height - height),
      ),
    ),
  };
}
function applyCompanionResize() {
  if (!companionWindow || companionWindow.isDestroyed() || drag) return;
  const bounds = companionWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const next = companionBounds(
    bounds,
    {
      conversation: hasCompanionConversation(snapshot),
      tasks: hasCompanionTasks(snapshot),
    },
    area,
  );
  if (next.width !== bounds.width || next.height !== bounds.height)
    companionWindow.setBounds(next);
}
function resizeCompanion(delayMs = 0) {
  if (!companionWindow || companionWindow.isDestroyed() || drag) return;
  const compact =
    !hasCompanionConversation(snapshot) && !hasCompanionTasks(snapshot);
  if (compact && resizeTimer) return;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  if (compact && delayMs > 0) {
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyCompanionResize();
    }, delayMs);
    return;
  }
  applyCompanionResize();
}

export function updateCompanionTasks(tasks: CompanionTask[]): void {
  const hadTasks = hasCompanionTasks(snapshot);
  snapshot = { ...snapshot, tasks };
  resizeCompanion(
    hadTasks &&
      !hasCompanionTasks(snapshot) &&
      !hasCompanionConversation(snapshot)
      ? COMPANION_TASK_EXIT_MS + 50
      : 0,
  );
  companionWindow?.webContents.send('companion:state', snapshot);
}

function endDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  const moved = drag?.moved ?? false;
  drag = null;
  resizeCompanion();
  if (companionWindow && !companionWindow.isDestroyed()) {
    const [x, y] = companionWindow.getPosition();
    positionStore.set('position', { x, y });
  }
  return moved;
}
function registerCompanionIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  app.on('before-quit', () => {
    quitting = true;
    endDrag();
  });
  ipcMain.handle('companion:get-state', () => snapshot);
  ipcMain.handle('companion:command', (event, command: unknown) => {
    if (event.sender !== companionWindow?.webContents) return;
    if (
      typeof command === 'string' &&
      ['start', 'stop', 'interrupt', 'audio-mode'].includes(command)
    )
      sendCompanionCommand(command);
  });
  ipcMain.handle('companion:publish', (event, next: CompanionSnapshot) => {
    // Only the main renderer owns the voice runtime; other windows cannot
    // publish voice state or create another microphone/playback path.
    if (event.sender.getURL().includes('/companion')) return;
    if (
      !next ||
      ![
        'idle',
        'listening',
        'thinking',
        'speaking',
        'working',
        'sleeping',
      ].includes(next.state)
    )
      return;
    // Appearance belongs to the main process, independently of voice updates.
    const hadTasks = hasCompanionTasks(snapshot);
    // The main process owns the task stack so it remains available even if the
    // hidden voice renderer is reloading or cannot publish state.
    snapshot = {
      ...next,
      tasks: snapshot.tasks,
      skinId: snapshot.skinId,
    };
    resizeCompanion(
      hadTasks &&
        !hasCompanionTasks(snapshot) &&
        !hasCompanionConversation(snapshot)
        ? COMPANION_TASK_EXIT_MS + 50
        : 0,
    );
    companionWindow?.webContents.send('companion:state', snapshot);
  });
  ipcMain.handle('companion:drag-start', (event) => {
    if (event.sender !== companionWindow?.webContents) return;
    endDrag();
    drag = {
      cursor: screen.getCursorScreenPoint(),
      bounds: companionWindow.getBounds(),
      moved: false,
    };
    dragTimer = setInterval(() => {
      if (!drag || !companionWindow || companionWindow.isDestroyed()) return;
      const cursor = screen.getCursorScreenPoint();
      const dx = cursor.x - drag.cursor.x,
        dy = cursor.y - drag.cursor.y;
      if (Math.hypot(dx, dy) > 5) drag.moved = true;
      if (drag.moved) {
        const position = clampPosition({
          x: drag.bounds.x + dx,
          y: drag.bounds.y + dy,
        });
        companionWindow.setPosition(position.x, position.y);
      }
    }, 16);
  });
  ipcMain.handle('companion:drag-end', (event) =>
    event.sender === companionWindow?.webContents ? endDrag() : false,
  );
  ipcMain.handle('companion:menu', (event) => {
    if (event.sender !== companionWindow?.webContents) return;
    endDrag();
    Menu.buildFromTemplate([
      { label: 'Open Cyrvis', click: () => void showWindow() },
      {
        label: 'Appearance',
        submenu: [...new Set(companionSkins.map((skin) => skin.group))].map(
          (group) => ({
            label: group,
            submenu: companionSkins
              .filter((skin) => skin.group === group)
              .map((skin) => ({
                label: skin.name,
                type: 'radio' as const,
                checked: skin.id === snapshot.skinId,
                click: () => {
                  positionStore.set('skinId', skin.id);
                  snapshot = { ...snapshot, skinId: skin.id };
                  companionWindow?.webContents.send(
                    'companion:state',
                    snapshot,
                  );
                },
              })),
          }),
        ),
      },
      { type: 'separator' },
      {
        label: snapshot.micReady ? 'Pause voice' : 'Start voice',
        click: () => sendCompanionCommand(snapshot.micReady ? 'stop' : 'start'),
      },
      { label: 'Wake up', click: () => sendCompanionCommand('wake') },
      {
        label: 'Interrupt response',
        click: () => sendCompanionCommand('interrupt'),
      },
      { label: 'Stop task', click: () => sendCompanionCommand('cancel') },
      {
        label:
          snapshot.audioMode === 'speaker'
            ? 'Use headset (voice interruption)'
            : 'Use speakers (echo protection)',
        click: () => sendCompanionCommand('audio-mode'),
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => sendCompanionCommand('settings') },
      { label: 'Quit Cyrvis', click: () => app.quit() },
    ]).popup({ window: companionWindow! });
  });
}
function createCompanionWindow() {
  positionStore ??= getCompanionStore();
  snapshot = {
    ...snapshot,
    skinId: resolveCompanionSkin(positionStore.get('skinId')).id,
  };
  const area = screen.getPrimaryDisplay().workArea;
  const position = clampPosition(
    positionStore.get('position') ?? {
      x: area.x + area.width - 292,
      y: area.y + area.height - 322,
    },
  );
  const window = new BrowserWindow({
    title: 'Cyrvis Companion',
    width: 260,
    height: 320,
    ...position,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  // The companion is user-visible content and must appear in screen recordings.
  window.setContentProtection(false);
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!app.isPackaged && env.rendererUrl)
    void window.loadURL(`${env.rendererUrl}#/companion`);
  else
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), {
      hash: '/companion',
    });
  window.once('ready-to-show', () => {
    resizeCompanion();
    window.showInactive();
  });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = null;
    endDrag();
    companionWindow = null;
  });
  windowManager.registerWindow(window);
  return window;
}
export function showCompanionWindow() {
  if (assistantCaptureActive()) return;
  if (!app.isReady() || quitting) return;
  registerCompanionIpc();
  if (!companionWindow || companionWindow.isDestroyed())
    companionWindow = createCompanionWindow();
  else {
    const [x, y] = companionWindow.getPosition();
    const p = clampPosition({ x, y });
    companionWindow.setPosition(p.x, p.y);
    companionWindow.showInactive();
  }
}
export function hideCompanionWindow() {
  endDrag();
  companionWindow?.hide();
}
