import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProactiveGaze } from './proactive';
import type { GazeSuggestion } from './suggestions';
import {
  gazeActionRequest,
  parseGazeSuggestion,
  resolveGazeReply,
} from './suggestions';

afterEach(() => vi.useRealTimers());

const music = () =>
  parseGazeSuggestion(
    JSON.stringify({
      kind: 'music',
      target: 'Day One',
      description: '你似乎在看《Day One》的封面',
      identified: true,
      confidence: 'high',
    }),
    100,
  )!;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  let now = 0;
  const deps = {
    inspect: vi.fn(async () => music()),
    cancel: vi.fn(),
    canInspect: vi.fn(() => true),
    onSuggestion: vi.fn((_suggestion: GazeSuggestion): boolean | void => true),
    now: () => now,
  };
  const controller = new ProactiveGaze(deps);
  const point = (at: number, x = 0.5, y = 0.5) => {
    now = at;
    controller.update({
      x,
      y,
      at,
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
  };
  const dwell = (start: number, x = 0.5) => {
    for (let at = start; at <= start + 4500; at += 500) point(at, x);
  };
  return {
    deps,
    controller,
    point,
    dwell,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe('proactive gaze', () => {
  it('preserves stable dwell across a short voice-busy interval', async () => {
    const { controller, deps, point } = setup();
    controller.configure(true);
    for (let at = 0; at <= 3000; at += 500) point(at);
    deps.canInspect.mockReturnValue(false);
    point(3500);
    point(4000);
    deps.canInspect.mockReturnValue(true);
    point(4500);
    await flush();
    expect(deps.inspect).toHaveBeenCalledOnce();
  });
  it('does not cache a reminder rejected by the voice transport', async () => {
    vi.useFakeTimers();
    const { controller, deps, dwell } = setup();
    deps.onSuggestion.mockReturnValue(false);
    controller.configure(true);
    dwell(0);
    await flush();
    expect(controller.getStatus().suggestion).toBeUndefined();
    expect(controller.getStatus().phase).toBe('waiting');
    deps.onSuggestion.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getStatus().suggestion?.target).toBe('Day One');
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(deps.onSuggestion).toHaveBeenCalledTimes(2);
  });
  it('finishes a captured observation despite a blink or a later target change', async () => {
    const { controller, deps, dwell, point } = setup();
    let finish!: (value: ReturnType<typeof music>) => void;
    deps.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.configure(true);
    dwell(0);
    const cancellations = deps.cancel.mock.calls.length;
    controller.update(null);
    point(10_000, 0.9);
    finish(music());
    await flush();
    expect(deps.cancel).toHaveBeenCalledTimes(cancellations);
    expect(deps.onSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        speech: expect.stringContaining('刚才'),
        gaze: expect.objectContaining({ x: 0.5 }),
      }),
    );
  });
  it('queues a completed result while voice is busy and delivers after it becomes ready', async () => {
    vi.useFakeTimers();
    const { controller, deps, dwell } = setup();
    let finish!: (value: ReturnType<typeof music>) => void;
    deps.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.configure(true);
    dwell(0);
    deps.canInspect.mockReturnValue(false);
    finish(music());
    await flush();
    expect(deps.onSuggestion).not.toHaveBeenCalled();
    expect(controller.getStatus().detail).toContain('等待语音');
    deps.canInspect.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
  });
  it('still cancels a queued result when the user explicitly disables reminders', async () => {
    vi.useFakeTimers();
    const { controller, deps, dwell } = setup();
    let finish!: (value: ReturnType<typeof music>) => void;
    deps.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.configure(true);
    dwell(0);
    deps.canInspect.mockReturnValue(false);
    finish(music());
    await flush();
    controller.configure(false);
    deps.canInspect.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.onSuggestion).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('retries an unannounced result on the same object instead of caching it as already reminded', async () => {
    const { controller, deps, dwell, point } = setup();
    deps.inspect
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce(music());
    controller.configure(true);
    dwell(0);
    await flush();
    expect(controller.getStatus().detail).toContain('尚未播报');
    expect(deps.onSuggestion).not.toHaveBeenCalled();
    for (let at = 5000; at <= 26000; at += 500) {
      point(at);
      await flush();
    }
    expect(deps.inspect).toHaveBeenCalledTimes(2);
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
    expect(controller.getStatus().detail).toContain('刚提醒过');
  });
  it('does no work until enabled, then inspects only after sustained local dwell', async () => {
    const { controller, deps, point, dwell } = setup();
    dwell(0);
    expect(deps.inspect).not.toHaveBeenCalled();
    controller.configure(true);
    for (let at = 5000; at < 9500; at += 500)
      point(at, 0.5 + (at % 1000 ? 0.01 : 0));
    expect(deps.inspect).not.toHaveBeenCalled();
    point(9500);
    await flush();
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
    expect(controller.getStatus().suggestion?.gaze?.x).toBe(0.5);
  });
  it('resets dwell on target change, tracking loss and busy voice', () => {
    const { controller, deps, point } = setup();
    controller.configure(true);
    for (let at = 0; at <= 3000; at += 500) point(at);
    point(3500, 0.8);
    point(4000, 0.8);
    controller.update(null);
    for (let at = 4500; at <= 7500; at += 500) point(at, 0.8);
    deps.canInspect.mockReturnValue(false);
    for (let at = 8000; at <= 14_000; at += 500) point(at, 0.8);
    expect(deps.inspect).not.toHaveBeenCalled();
  });
  it('drops a completed result if the gaze moved or the feature was disabled', async () => {
    const { controller, deps, dwell, point } = setup();
    let finish!: (value: ReturnType<typeof music>) => void;
    deps.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.configure(true);
    dwell(0);
    point(5000, 0.9);
    controller.configure(false);
    finish(music());
    await flush();
    expect(deps.onSuggestion).not.toHaveBeenCalled();
    expect(controller.getStatus().phase).toBe('off');
    expect(deps.cancel).toHaveBeenCalled();
  });
  it('deduplicates the same position and confirmed work for 45 seconds', async () => {
    const { controller, deps, dwell, point } = setup();
    controller.configure(true);
    dwell(0);
    await flush();
    for (let at = 5000; at <= 35_000; at += 500) point(at);
    expect(deps.inspect).toHaveBeenCalledOnce();
    dwell(36_000, 0.8);
    await flush();
    expect(deps.inspect).toHaveBeenCalledTimes(2);
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
  });
  it('inspects another object before a minute and does not deduplicate generic cover descriptions', async () => {
    const { controller, deps, dwell } = setup();
    const unknown = parseGazeSuggestion(
      JSON.stringify({
        kind: 'music',
        description: '唱片封面',
        candidate: '同一个错误候选',
        visible: true,
        confidence: 'high',
        identified: false,
      }),
      0,
    )!;
    deps.inspect.mockResolvedValue(unknown);
    controller.configure(true);
    dwell(0);
    await flush();
    expect(deps.onSuggestion).toHaveBeenCalledOnce();
    dwell(13_000, 0.8);
    await flush();
    expect(deps.inspect).toHaveBeenCalledTimes(2);
    expect(deps.onSuggestion).toHaveBeenCalledTimes(2);
    expect(controller.getStatus().suggestion?.gaze?.x).toBe(0.8);
  });
  it('recognizes new object content at the same screen position', async () => {
    const { controller, deps, setNow } = setup();
    controller.configure(true);
    deps.inspect.mockImplementation(async () => ({
      ...music(),
      target: '',
      identified: false,
    }));
    const object = (at: number, id: string) => {
      setNow(at);
      controller.update({
        x: 0.5,
        y: 0.5,
        at,
        displayId: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        target: {
          id,
          scene: 'music',
          label: '封面',
          role: 'AXImage',
          source: 'vision',
          bounds: { x: 500, y: 300, width: 180, height: 180 },
        },
      });
    };
    for (let at = 0; at <= 4500; at += 500) object(at, 'cover-a');
    await flush();
    for (let at = 13_000; at <= 17_500; at += 500) object(at, 'cover-b');
    await flush();
    expect(deps.onSuggestion).toHaveBeenCalledTimes(2);
  });
  it('resumes on the same object after the deduplication window', async () => {
    const { controller, deps, dwell, point } = setup();
    controller.configure(true);
    dwell(0);
    await flush();
    for (let at = 5000; at <= 55_000; at += 500) {
      point(at);
      await flush();
    }
    expect(deps.onSuggestion).toHaveBeenCalledTimes(2);
  });
  it('shows remaining cooldown and a busy reason then resumes when idle', async () => {
    const { controller, deps, dwell, point, setNow } = setup();
    Object.assign(deps, { blockedReason: () => '桌面任务正在执行' });
    controller.configure(true);
    controller.snooze();
    point(1000);
    expect(controller.getStatus().retryInMs).toBe(7000);
    setNow(8000);
    deps.canInspect.mockReturnValue(false);
    point(8000);
    expect(controller.getStatus().detail).toBe('桌面任务正在执行');
    deps.canInspect.mockReturnValue(true);
    dwell(8500);
    await flush();
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(controller.getStatus().error).toBeUndefined();
  });
  it('ignores stale and uncertain observations and backs off after errors', async () => {
    const { controller, deps, dwell, point } = setup();
    deps.inspect.mockRejectedValue(new Error('model unavailable'));
    controller.configure(true);
    dwell(0);
    await flush();
    for (let at = 5000; at <= 16_000; at += 500) point(at);
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(controller.getStatus().error).toBe('model unavailable');
  });
});
describe('grounded proactive suggestions', () => {
  it('offers explicit visual playback or verification without speaking an unverified name', () => {
    const value = parseGazeSuggestion(
      JSON.stringify({
        kind: 'music',
        target: '',
        candidate: '示例艺人的示例专辑',
        description: '一张没有文字的唱片封面',
        visible: true,
        identified: false,
        confidence: 'high',
        identityConfidence: 'low',
      }),
      0,
    )!;
    expect(value.identified).toBe(false);
    expect(value.target).toBe('');
    expect(value.speech).toContain('核实作品信息');
    expect(value.speech).toContain(value.description);
    expect(value.speech).not.toContain('示例艺人');
    expect(value.actions.map((item) => item.kind)).toEqual(['play', 'explain']);
    expect(resolveGazeReply('核实一下', value)).toBe('explain');
    expect(resolveGazeReply('播放它', value)).toBe('play');
  });
  it('describes a visible unnamed cover even if work identity confidence is low', () => {
    const suggestion = parseGazeSuggestion(
      JSON.stringify({
        kind: 'music',
        target: '',
        description: '一张唱片封面，中间有一张人物照片',
        visible: true,
        ambiguous: false,
        identified: false,
        confidence: 'low',
        identityConfidence: 'low',
      }),
      0,
    );
    expect(suggestion?.speech).toContain('人物照片');
    expect(suggestion?.speech).toContain('播放它，还是核实作品信息');
    expect(suggestion?.actions.map((item) => item.kind)).toEqual([
      'play',
      'explain',
    ]);
  });
  it('offers supported two-choice menus for text and unknown images', () => {
    const text = parseGazeSuggestion(
      JSON.stringify({
        kind: 'text',
        description: '一大段文章的内容',
        confidence: 'high',
      }),
      0,
    )!;
    expect(text.actions.map((a) => a.kind)).toEqual(['summarize', 'explain']);
    expect(resolveGazeReply('总结重点', text)).toBe('summarize');
    expect(gazeActionRequest(text, 'summarize')).toContain('2至3条要点');
    const image = parseGazeSuggestion(
      JSON.stringify({
        kind: 'image',
        description: '一幅画',
        confidence: 'high',
      }),
      0,
    )!;
    expect(image.actions.map((a) => a.kind)).toEqual(['open', 'explain']);
    expect(resolveGazeReply('打开它', image)).toBe('open');
    expect(resolveGazeReply('第二个', image)).toBe('explain');
    expect(image.speech).toContain('一幅画');
  });
  it('still stays silent for blank or ambiguous images rather than guessing', () => {
    for (const flags of [
      { visible: false, ambiguous: false },
      { visible: true, ambiguous: true },
    ]) {
      expect(
        parseGazeSuggestion(
          JSON.stringify({
            kind: 'image',
            description: '无法确认',
            confidence: 'low',
            ...flags,
          }),
          0,
        ),
      ).toBeNull();
    }
  });
  it('offers three concise music choices and resolves both words and option numbers', () => {
    const suggestion = music();
    expect(suggestion.actions.map((item) => item.kind)).toEqual([
      'play',
      'explain',
      'story',
    ]);
    expect(suggestion.speech.length).toBeLessThan(70);
    expect(suggestion.speech).toContain('《Day One》');
    expect(suggestion.speech).not.toContain(suggestion.description);
    expect(resolveGazeReply('第一个', suggestion)).toBe('play');
    expect(resolveGazeReply('选2', suggestion)).toBe('explain');
    expect(resolveGazeReply('第三项', suggestion)).toBe('story');
    expect(resolveGazeReply('播放它', suggestion)).toBe('play');
    expect(resolveGazeReply('讲讲封面背景', suggestion)).toBe('story');
    expect(resolveGazeReply('好', suggestion)).toBe('clarify');
    expect(resolveGazeReply('不用播放', suggestion)).toBe('dismiss');
    expect(resolveGazeReply('播放周杰伦的歌', suggestion)).toBeNull();
    expect(resolveGazeReply('介绍一下北京的历史', suggestion)).toBeNull();
  });
  it('offers visual playback without inventing a cover identity', () => {
    const suggestion = parseGazeSuggestion(
      '```json\n{"kind":"music","target":"","description":"这是一张音乐封面","identified":false,"confidence":"medium"}\n```',
      0,
    )!;
    expect(suggestion.actions.map((item) => item.kind)).toEqual([
      'play',
      'explain',
    ]);
    expect(suggestion.target).toBe('');
    expect(resolveGazeReply('播放', suggestion)).toBe('play');
    expect(
      parseGazeSuggestion(
        '{"kind":"image","description":"无法区分","confidence":"low"}',
        0,
      ),
    ).toBeNull();
  });
});
