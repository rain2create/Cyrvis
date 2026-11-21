import { describe, it, expect } from 'vitest';
import {
  gazeDesktopAction,
  gazeDesktopInstruction,
  selectGazeActionContext,
  type GazeActionContext,
} from './actions';
const context = (at: number, id = 'playlist'): GazeActionContext => ({
  gaze: {
    x: 0.5,
    y: 0.5,
    at,
    displayId: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    target: {
      id,
      scene: 'music',
      label: '歌单',
      role: 'AXImage',
      source: 'accessibility',
      bounds: { x: 500, y: 300, width: 180, height: 180 },
    },
  },
  observedAt: at,
});
describe('gaze desktop actions', () => {
  it('distinguishes authorized object operations from inspection and denied operations', () => {
    expect(gazeDesktopAction('呃你帮我点一下，然后播放这个歌单就行。')).toBe(
      'click-play',
    );
    expect(gazeDesktopAction('点击这个')).toBe('click');
    expect(gazeDesktopAction('点它')).toBe('click');
    expect(gazeDesktopAction('播放它')).toBe('play');
    for (const text of [
      '我在看什么',
      '解释这个歌单',
      '不要播放它',
      '先别点击这个',
      '为什么不能点击这个',
      '点击这个支付按钮',
      '播放周杰伦的歌',
      '你是不是不能点击这个',
      '告诉我怎么播放这个歌单',
    ])
      expect(gazeDesktopAction(text)).toBeNull();
  });
  it('keeps the spoken referent while a reply looks at the chat panel, but honors an explicit current gaze', () => {
    const old = context(1000),
      live = context(1500, 'chat-button').gaze;
    live.target!.role = 'AXTextField';
    live.target!.label = '对话输入';
    expect(
      selectGazeActionContext('播放这个歌单', live, [old], 2000)?.gaze.target
        ?.id,
    ).toBe('playlist');
    expect(
      selectGazeActionContext('点击光标指向的这个', live, [old], 2000)?.gaze
        .target?.id,
    ).toBe('chat-button');
    expect(selectGazeActionContext('播放这个', null, [old], 70_000)).toBeNull();
  });
  it('binds the intended object as data and requires fresh visual verification before acting', () => {
    const instruction = gazeDesktopInstruction(
      '播放这个歌单',
      'play',
      context(0),
    );
    expect(instruction).toContain('重新截图');
    expect(instruction).toContain('不要盲点');
    expect(instruction).toContain('objectBounds');
    expect(instruction).not.toContain('inspect_gaze_target');
  });
});
