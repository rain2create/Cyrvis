import { afterEach, expect, it, vi } from 'vitest';
import { WebAudioStreamPlayer } from './webaudio-player';

afterEach(() => vi.unstubAllGlobals());
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup(resumeFailure = false) {
  const source = {
    buffer: null as any,
    start: vi.fn(),
    stop: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onended: null as (() => void) | null,
  };
  const context = {
    state: 'suspended',
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      if (resumeFailure) throw new Error('输出设备没有响应');
      context.state = 'running';
    }),
    close: vi.fn(async () => {
      context.state = 'closed';
    }),
    setSinkId: vi.fn(async (_id: string) => {}),
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
    createBuffer: (_channels: number, size: number, rate: number) => ({
      duration: size / rate,
      getChannelData: () => new Float32Array(size),
    }),
    createBufferSource: () => source,
  };
  vi.stubGlobal(
    'AudioContext',
    vi.fn(() => context),
  );
  const idle = vi.fn(),
    error = vi.fn(),
    segment = vi.fn();
  return {
    context,
    source,
    idle,
    error,
    segment,
    player: new WebAudioStreamPlayer(idle, error, segment),
  };
}

it('applies the selected output and reports playback only after scheduling actual audio', async () => {
  const { context, player, source, segment, error } = setup();
  await player.setSinkId('test-speakers');
  expect(context.setSinkId).toHaveBeenCalledWith('test-speakers');
  expect(segment).not.toHaveBeenCalled();
  player.play(new Int16Array(12000));
  await flush();
  expect(source.start).toHaveBeenCalledOnce();
  expect(segment).toHaveBeenCalledOnce();
  expect(source.start.mock.invocationCallOrder[0]).toBeLessThan(
    segment.mock.invocationCallOrder[0],
  );
  expect(error).not.toHaveBeenCalled();
  player.stop(false);
});

it('surfaces a suspended output error instead of silently accepting an inaudible queue', async () => {
  const { player, source, segment, error } = setup(true);
  player.play(new Int16Array(12000));
  await flush();
  expect(source.start).not.toHaveBeenCalled();
  expect(segment).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: '输出设备没有响应' }),
  );
});
