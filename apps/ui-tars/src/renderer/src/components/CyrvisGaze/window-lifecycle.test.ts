// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act, Suspense, useState } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { createRoot, type Root } from 'react-dom/client';

// Separate Electron windows have independent locations. MemoryRouter lets
// two React roots model them without sharing this test document's hash events.
vi.mock('react-router', async (original) => {
  const router = await original<typeof import('react-router')>();
  return {
    ...router,
    HashRouter: ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        router.MemoryRouter,
        { initialEntries: [location.hash.slice(1) || '/'] },
        children,
      ),
  };
});
vi.mock('@renderer/components/CyrvisVoice/VoiceRuntime', () => ({
  VoiceRuntime: () => null,
}));
vi.mock('@renderer/components/CyrvisRuntime', () => ({ default: () => null }));
vi.mock('@/renderer/src/components/SideBar/app-sidebar', () => ({
  AppSidebar: () => null,
}));
vi.mock('@renderer/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  SidebarInset: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  SidebarTrigger: () => null,
}));
vi.mock('@renderer/components/Proactivity/FollowUpDialog', () => ({
  FollowUpDialog: () => React.createElement('div', null, 'Follow-up dialog'),
}));
vi.mock('sonner', () => ({ Toaster: () => null }));
vi.mock('../../pages/home', () => ({ default: () => null }));
vi.mock('../../pages/local', () => ({ default: () => null }));
vi.mock('../../pages/remote/free', () => ({ default: () => null }));
vi.mock('../../pages/widget', () => ({ default: () => null }));
vi.mock('../../pages/history', () => ({ default: () => null }));
vi.mock('../CyrvisCompanion/Companion', () => ({ default: () => null }));
import App from '../../App';
import { MainLayout } from '../../layouts/MainLayout';

const roots: Root[] = [];
async function renderWindow(path: string) {
  location.hash = path;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(App));
  });
  return { root, container };
}
afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = '';
});

describe('gaze camera ownership across Electron windows', () => {
  it('keeps gaze controls visible when a history page suspends', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const invoke = vi.fn(async () => ({ enabled: false, phase: 'idle' }));
    (window as any).electron = { ipcRenderer: { invoke } };
    window.webgazer = { end: vi.fn() };
    const loading = new Promise<never>(() => {});
    let suspendHistory!: (value: boolean) => void;
    function LoadingHistory(): React.ReactNode {
      const [pending, setPending] = useState(false);
      suspendHistory = setPending;
      if (pending) throw loading;
      return '聊天记录';
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/history/shot-a'] },
          React.createElement(
            Suspense,
            { fallback: '整个工作台加载中' },
            React.createElement(
              Routes,
              null,
              React.createElement(
                Route,
                { element: React.createElement(MainLayout) },
                React.createElement(Route, {
                  path: '/history/:id',
                  element: React.createElement(LoadingHistory),
                }),
              ),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      suspendHistory(true);
    });
    expect(container.textContent).toContain('正在载入对话');
    expect(container.textContent).toContain('眼动');
    expect(container.textContent).toContain('Follow-up dialog');
    expect(container.textContent).not.toContain('整个工作台加载中');
    expect(window.webgazer.end).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      'cyrvis:gaze:inspect-enabled',
      false,
    );
  });

  it('closing a task widget cannot end the workbench camera or clear shared gaze', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const invoke = vi.fn(async () => ({ enabled: false, phase: 'idle' }));
    (window as any).electron = { ipcRenderer: { invoke } };
    window.webgazer = { end: vi.fn() };
    const main = await renderWindow('/');
    expect(main.container.textContent).toContain('眼动');
    expect(main.container.textContent).toContain('Follow-up dialog');
    const widget = await renderWindow('/widget');
    expect(widget.container.textContent).not.toContain('眼动');
    await act(async () => {
      widget.root.unmount();
    });
    roots.splice(roots.indexOf(widget.root), 1);
    expect(window.webgazer.end).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      'cyrvis:gaze:inspect-enabled',
      false,
    );
    expect(invoke).not.toHaveBeenCalledWith('cyrvis:gaze:update', null);
    const companion = await renderWindow('/companion');
    expect(companion.container.textContent).not.toContain('眼动');
    await act(async () => {
      companion.root.unmount();
    });
    roots.splice(roots.indexOf(companion.root), 1);
    expect(window.webgazer.end).not.toHaveBeenCalled();
  });
});
