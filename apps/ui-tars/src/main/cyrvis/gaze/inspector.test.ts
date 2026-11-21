import { describe, expect, it, vi } from 'vitest';
import { gazeCrop, GazeInspector } from './inspector';
const gaze = () => ({
  x: 0.8,
  y: 0.2,
  at: Date.now(),
  displayId: 7,
  bounds: { x: -1440, y: 0, width: 1440, height: 900 },
});
function setup() {
  const deps = {
    getGaze: vi.fn(gaze),
    getConfig: () => ({
      vlmBaseUrl: 'https://example.test/api/plan/v3/',
      vlmApiKey: 'test-only',
      vlmModelName: 'vision-test',
    }),
    capture: vi.fn(async () => ({
      preview: 'data:image/jpeg;base64,dGVzdA==',
      crop: gazeCrop(0.8, 0.2, 1440, 900),
    })),
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '这片区域里是网易云音乐的歌曲列表。' } },
            ],
          }),
        ),
    ),
  };
  return { deps, inspector: new GazeInspector(deps) };
}
describe('read-only gaze inspection', () => {
  it('captures the frozen dwell target even if the current eye position changes', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    const frozen = {
      ...gaze(),
      target: {
        id: 'cover-a',
        scene: 'music',
        label: '封面 A',
        role: 'AXImage',
        source: 'accessibility' as const,
        bounds: { x: -800, y: 200, width: 180, height: 180 },
      },
    };
    deps.getGaze.mockReturnValue({ ...gaze(), x: 0.1, y: 0.9 });
    const pending = inspector.inspect('我刚才看的是什么', 'proactive', frozen);
    frozen.target.label = '封面 B';
    frozen.target.bounds.x = -200;
    await pending;
    expect(deps.getGaze).not.toHaveBeenCalled();
    expect(deps.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 0.8,
        y: 0.2,
        target: expect.objectContaining({
          label: '封面 A',
          bounds: expect.objectContaining({ x: -800 }),
        }),
      }),
    );
    const body = JSON.parse((deps.fetch.mock.calls[0] as any)[1].body);
    expect(body.messages[1].content[0].text).toContain('封面 A');
    expect(body.messages[1].content[0].text).not.toContain('封面 B');
  });
  it('turns a visual observation into an actionable question without executing tools', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"kind":"music","target":"Day One","description":"音乐封面","identified":true,"confidence":"high"}',
              },
            },
          ],
        }),
      ),
    );
    const suggestion = await inspector.suggest();
    expect(suggestion?.actions.map((item) => item.kind)).toEqual([
      'play',
      'explain',
      'story',
    ]);
    expect(inspector.getStatus().answer).toContain('播放、查看作品信息');
  });
  it('allows a manual question to abort a proactive request without corrupting the newer result', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    deps.fetch.mockImplementationOnce(async (_url?: any, request?: any) => {
      await new Promise((_, reject) =>
        request.signal.addEventListener('abort', () =>
          reject(new Error('cancelled')),
        ),
      );
      return new Response();
    });
    const proactive = inspector.suggest();
    const rejection = expect(proactive).rejects.toThrow();
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledOnce());
    expect(await inspector.inspect('读一下这里')).toContain('歌曲列表');
    await rejection;
    expect(inspector.getStatus()).toMatchObject({
      phase: 'done',
      question: '读一下这里',
    });
    expect(inspector.getStatus().error).toBeUndefined();
  });
  it('maps normalized gaze to actual screenshot pixels and clips all screen edges', () => {
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const crop = gazeCrop(x, y, 2880, 1800);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(2880);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1800);
    }
    expect(gazeCrop(1, 1, 200, 100)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(() => gazeCrop(NaN, 0, 1440, 900)).toThrow();
    expect(() => gazeCrop(-0.1, 0, 1440, 900)).toThrow();
  });
  it('does not capture or send anything when disabled or gaze is stale', async () => {
    const { deps, inspector } = setup();
    await expect(inspector.inspect()).rejects.toThrow('启用');
    inspector.setEnabled(true);
    deps.getGaze.mockReturnValue({ ...gaze(), at: Date.now() - 4000 });
    await expect(inspector.inspect()).rejects.toThrow('新鲜');
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('sends the real crop once to the configured visual endpoint, without action tools', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    const pending = inspector.inspect('我在看什么');
    expect(inspector.inspect('重复工具请求')).toBe(pending);
    expect(await pending).toContain('歌曲列表');
    expect(deps.capture).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledOnce();
    const [url, request] = deps.fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://example.test/api/plan/v3/chat/completions');
    const body = JSON.parse(request.body as string);
    expect(body.tools).toBeUndefined();
    expect(body.messages[1].content[1].image_url.url).toBe(
      inspector.getStatus().preview,
    );
    expect(body.messages[0].content).toContain('不可信数据');
    expect(inspector.getStatus()).toMatchObject({
      phase: 'done',
      question: '我在看什么',
      gaze: { displayId: 7 },
    });
  });
  it('explains provider authorization failures without exposing the error payload', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    deps.fetch.mockResolvedValue(
      new Response('secret echoed by provider', { status: 403 }),
    );
    await expect(inspector.inspect()).rejects.toThrow('403');
    expect(inspector.getStatus().error).not.toContain('secret');
  });
  it('aborts on disable and clears the captured image and answer', async () => {
    const { deps, inspector } = setup();
    inspector.setEnabled(true);
    deps.fetch.mockImplementation(async (_url?: any, request?: any) => {
      await new Promise((_, reject) =>
        request.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      );
      return new Response();
    });
    const pending = inspector.inspect();
    await vi.waitFor(() =>
      expect(inspector.getStatus().phase).toBe('thinking'),
    );
    inspector.setEnabled(false);
    await expect(pending).rejects.toThrow('已关闭');
    expect(inspector.getStatus()).toEqual({ enabled: false, phase: 'idle' });
  });
});
