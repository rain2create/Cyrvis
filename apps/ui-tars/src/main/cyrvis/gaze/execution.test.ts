import { expect, it, vi } from 'vitest';
import {
  assertGazeClick,
  COMPACT_GUI_PROMPT,
  gazeExecutionRect,
  gazeExecutionReference,
} from './execution';
import {
  withoutAssistantOverlays,
  assistantCaptureActive,
} from '@main/window/capture';

const ref = {
  objectBounds: { x: 234, y: 116, width: 169, height: 219 },
  displayBounds: { x: 0, y: 0, width: 1470, height: 956 },
  observedAt: 1000,
};
it('marks the actual gaze object and rejects the wrong playlist coordinate seen in the failed task', () => {
  const instruction = `播放它\n[已绑定注视对象] 参考：${JSON.stringify(ref)}`;
  expect(gazeExecutionReference(instruction, 2000)).toEqual(ref);
  expect(gazeExecutionRect(ref, 2940, 1912)).toEqual({
    x: 468,
    y: 232,
    width: 338,
    height: 438,
  });
  expect(() =>
    assertGazeClick(ref, '[0.795,0.195,0.795,0.195]', 1470, 956),
  ).toThrow('超出了');
  expect(() =>
    assertGazeClick(ref, '[0.217,0.236,0.217,0.236]', 1470, 956),
  ).not.toThrow();
  expect(() => gazeExecutionReference(instruction, 122000)).toThrow('过期');
  expect(COMPACT_GUI_PROMPT).toContain('Do NOT output Thought');
});
it('removes assistant overlays during capture and restores them even on failure', async () => {
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isAlwaysOnTop: () => true,
    getTitle: () => 'Cyrvis Companion',
    hide: vi.fn(),
    showInactive: vi.fn(),
  };
  await expect(
    withoutAssistantOverlays(async () => {
      expect(assistantCaptureActive()).toBe(true);
      expect(window.hide).toHaveBeenCalledOnce();
      expect(window.showInactive).not.toHaveBeenCalled();
      throw new Error('capture failed');
    }, [window]),
  ).rejects.toThrow('capture failed');
  expect(assistantCaptureActive()).toBe(false);
  expect(window.showInactive).toHaveBeenCalledOnce();
});
