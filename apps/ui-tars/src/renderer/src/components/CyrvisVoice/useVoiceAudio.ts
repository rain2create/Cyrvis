import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BREEZE_TTS_DEFAULT_BASE_URL,
  BREEZE_TTS_DEFAULT_INSTRUCTION,
  BREEZE_TTS_DEFAULT_SEED,
  toBreezeTtsWebSocketUrl,
} from '@shared/voice';
import { normalizeBreezeVoiceId } from '@shared/breezeTts';
import { useSetting } from '@renderer/hooks/useSetting';

import { WebAudioStreamPlayer } from './webaudio-player';
import {
  appendAudioPreroll,
  appendPcm16,
  calculateRms,
  downsamplePcm,
  floatToPcm16,
  takePcmChunks,
} from '../../utils/audio';
import {
  BreezeStreamingPlayer,
  type BreezeStreamConfig,
  waitForAudioStart,
} from '../../utils/breezeTtsStream';
import { QwenTtsStreamingPlayer } from '../../utils/qwenTtsStream';
import {
  MIN_ENDPOINT_SILENCE_MS,
  shouldFinishStreamingUtterance,
} from '../../utils/voiceEndpoint';

let voiceOwner: symbol | null = null;

const BARGE_CONFIRMATION_FRAMES = 2;
// Full commands spoken over the speaker were repeatedly missed at 0.05/3
// frames. Two AEC frames at 0.04 still reject steady echo but let normal
// speech start the command capture before the first words are lost.
const TTS_BARGE_THRESHOLD = 0.04;

// Speaker mode has two phases. The AEC/AGC transient right after playback
// starts can briefly push residual echo above the steady-state floor, so keep
// the loud/long confirmation for the first 450ms. After that, use the known
// 0.05/3 baseline: 0.12/4 made a normal speaking voice sound like a shout.
const SPEAKER_ONSET_GUARD_MS = 450;
const SPEAKER_ONSET_BARGE_THRESHOLD = 0.12;
const SPEAKER_ONSET_BARGE_FRAMES = 4;
const SPEAKER_TTS_BARGE_THRESHOLD = 0.05;
const SPEAKER_BARGE_CONFIRMATION_FRAMES = 3;
const MAX_BARGE_PREROLL_CHUNKS = 8;
const BARGE_ENDPOINT_SILENCE_MS = MIN_ENDPOINT_SILENCE_MS;

export interface VoiceTaskSnapshot {
  taskId: string | null;
  status: string;
  instruction: string | null;
  step: number;
  lastSummary: string | null;
  error: string | null;
}

export interface VoiceUiState {
  awake: boolean;
  userSpeaking: boolean;
  ttsSpeaking: boolean;
  lastUserText: string;
  task: VoiceTaskSnapshot;
}

export interface OutputDeviceOption {
  deviceId: string;
  label: string;
}

type StreamingPlayer = {
  readonly isActive: boolean;
  start: () => Promise<void>;
  appendText: (text: string) => void;
  finish: () => Promise<void>;
  cancel: () => void;
  setSinkId?: (deviceId: string) => Promise<void>;
};

const EMPTY_STATE: VoiceUiState = {
  awake: false,
  userSpeaking: false,
  ttsSpeaking: false,
  lastUserText: '',
  task: {
    taskId: null,
    status: 'idle',
    instruction: null,
    step: 0,
    lastSummary: null,
    error: null,
  },
};

const VIRTUAL_MIC_PATTERN = /todesk|virtual|stereo mix|line in/i;
const PREFERRED_MIC_PATTERN =
  /cc ultimate|headset|airpods|bluetooth|耳机|耳麦/i;

/**
 * The Windows default input is often the ToDesk virtual cable, which produces
 * silence. Prefer a real microphone instead of marking voice as ready.
 */
const openMicrophoneStream = async (
  echoCancellation: boolean,
): Promise<MediaStream> => {
  const constraints: MediaTrackConstraints = {
    echoCancellation,
    noiseSuppression: false,
    autoGainControl: true,
    channelCount: 1,
  };
  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    const label = stream.getAudioTracks()[0]?.label || '';
    if (!VIRTUAL_MIC_PATTERN.test(label)) {
      return stream;
    }

    console.log('[cyrvis] default mic is virtual; switching', { label });
    stream.getTracks().forEach((track) => track.stop());
    stream = null;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const physical = devices.filter(
      (device) =>
        device.kind === 'audioinput' &&
        device.deviceId &&
        device.label &&
        !VIRTUAL_MIC_PATTERN.test(device.label),
    );
    if (!physical.length) {
      throw new Error('未找到物理麦克风，请连接耳机麦克风后重新开始语音。');
    }
    const preferred =
      physical.find((device) => PREFERRED_MIC_PATTERN.test(device.label)) ??
      physical[0];
    console.log('[cyrvis] switching to physical mic', {
      label: preferred.label,
    });
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...constraints, deviceId: { exact: preferred.deviceId } },
    });
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法启动麦克风：${message}`);
  }
};

export function useVoiceAudio() {
  const { settings } = useSetting();
  const [state, setState] = useState<VoiceUiState>(EMPTY_STATE);
  const [transcript, setTranscript] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [micReady, setMicReady] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const [playbackActive, setPlaybackActive] = useState(false);
  const [audioMode, setAudioModeState] = useState<'headset' | 'speaker'>(
    'headset',
  );
  const [outputDevices, setOutputDevices] = useState<OutputDeviceOption[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ptt, setPtt] = useState<{ active: boolean; mode: boolean }>({
    active: false,
    mode: true,
  });

  const settingsRef = useRef(settings);
  const ownerRef = useRef(Symbol('cyrvis-voice-instance'));
  const captureContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const rawCaptureContextRef = useRef<AudioContext | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const rawSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rawProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const rawGainRef = useRef<GainNode | null>(null);
  const rawKeywordPcmRef = useRef(new Uint8Array());
  const rawKeywordActiveRef = useRef(false);
  const playerRef = useRef<StreamingPlayer | null>(null);
  const legacyPlayerRef = useRef<WebAudioStreamPlayer | null>(null);
  const playerStartRef = useRef<Promise<void> | null>(null);
  const playerEpochRef = useRef(0);
  const outputDeviceIdRef = useRef('');
  const transcriptRef = useRef('');
  const disposedRef = useRef(false);

  const streamingUtteranceActiveRef = useRef(false);
  const bargePendingRef = useRef(false);
  const captureSampleRateRef = useRef(48_000);
  const recordingStartedAtRef = useRef(0);
  const lastSpeechAtRef = useRef(0);
  const pendingPcmRef = useRef(new Uint8Array());
  const keywordPcmRef = useRef(new Uint8Array());
  const bargePrerollRef = useRef<Float32Array[]>([]);
  const assistantSpeakingRef = useRef(false);
  const readoutGuardUntilRef = useRef(0);
  const readoutIdRef = useRef<string | undefined>(undefined);
  const readoutPlayingRef = useRef(false);
  const assistantTextStartedRef = useRef(false);
  const assistantPlaybackStartedAtRef = useRef(0);
  const speechDeltaRef = useRef('');
  const speechDeltaSeenRef = useRef(false);
  const firstAudioPromiseRef = useRef<Promise<boolean> | null>(null);
  const resolveFirstAudioRef = useRef<((started: boolean) => void) | null>(
    null,
  );
  const assistantIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const noiseFloorRef = useRef(0.006);
  const speechFramesRef = useRef(0);
  const bargeFramesRef = useRef(0);
  const audioModeRef = useRef<'headset' | 'speaker'>('headset');
  const lastBargeDiagRef = useRef(0);

  settingsRef.current = settings;

  const clearIdleTimer = () => {
    if (assistantIdleTimerRef.current) {
      clearTimeout(assistantIdleTimerRef.current);
      assistantIdleTimerRef.current = null;
    }
  };

  const finishPlayback = useCallback(() => {
    if (readoutIdRef.current)
      window.electron.voice.reportGazePlayback(readoutIdRef.current, 'spoken');
    readoutIdRef.current = undefined;
    readoutPlayingRef.current = false;
    clearIdleTimer();
    legacyPlayerRef.current = null;
    assistantSpeakingRef.current = false;
    assistantPlaybackStartedAtRef.current = 0;
    bargeFramesRef.current = 0;
    keywordPcmRef.current = new Uint8Array();
    setPlaybackActive(false);
    window.electron.voice.notifyPlaybackIdle();
  }, []);

  const cancelPlayer = useCallback((notifyMain = false) => {
    if (readoutIdRef.current)
      window.electron.voice.reportGazePlayback(
        readoutIdRef.current,
        'cancelled',
      );
    readoutIdRef.current = undefined;
    readoutPlayingRef.current = false;
    playerEpochRef.current += 1;
    const player = playerRef.current;
    playerRef.current = null;
    playerStartRef.current = null;
    player?.cancel();
    const legacy = legacyPlayerRef.current;
    legacyPlayerRef.current = null;
    legacy?.stop(false);
    assistantSpeakingRef.current = false;
    assistantPlaybackStartedAtRef.current = 0;
    speechDeltaRef.current = '';
    speechDeltaSeenRef.current = false;
    resolveFirstAudioRef.current?.(false);
    resolveFirstAudioRef.current = null;
    firstAudioPromiseRef.current = null;
    clearIdleTimer();
    setPlaybackActive(false);
    if (notifyMain) {
      window.electron.voice.notifyPlaybackStopped({ queuedMs: 0 });
    }
  }, []);

  const createPlayer = useCallback(async (epoch: number) => {
    const current = settingsRef.current;
    const provider =
      current.voiceTtsProvider === 'qwen-tts-realtime'
        ? 'qwen-tts-realtime'
        : 'breeze-local';
    console.info('[cyrvis] creating streaming TTS player', { provider });
    let player: StreamingPlayer;
    if (provider === 'qwen-tts-realtime') {
      player = new QwenTtsStreamingPlayer({
        requestId: `cyrvis-${Date.now()}`,
        mode: current.voiceQwenTtsMode || 'commit',
        language: current.voiceQwenTtsLanguage || 'Chinese',
        onFirstAudio: () => {
          if (readoutIdRef.current && !readoutPlayingRef.current) {
            readoutPlayingRef.current = true;
            window.electron.voice.reportGazePlayback(
              readoutIdRef.current,
              'playing',
            );
          }
          resolveFirstAudioRef.current?.(true);
          resolveFirstAudioRef.current = null;
        },
      });
    } else {
      const readiness = await window.electron.voice.ensureBreezeReady();
      if (!readiness.ok) {
        throw new Error(readiness.error || 'Breeze TTS is unavailable');
      }
      const voiceId = normalizeBreezeVoiceId(current.voiceTtsVoice);
      if (voiceId) {
        const voices = await window.electron.voice.listBreezeVoices();
        if (!voices.some((voice) => voice.id === voiceId)) {
          throw new Error(`Selected Breeze voice is unavailable: ${voiceId}`);
        }
      }
      player = new BreezeStreamingPlayer({
        wsUrl: toBreezeTtsWebSocketUrl(
          current.voiceTtsBaseUrl || BREEZE_TTS_DEFAULT_BASE_URL,
        ),
        instruction:
          current.voiceTtsInstruction || BREEZE_TTS_DEFAULT_INSTRUCTION,
        voiceId,
        cfgScale: current.voiceTtsCfgScale ?? 1,
        seed: current.voiceTtsSeed ?? BREEZE_TTS_DEFAULT_SEED,
        onFirstAudio: () => {
          if (readoutIdRef.current && !readoutPlayingRef.current) {
            readoutPlayingRef.current = true;
            window.electron.voice.reportGazePlayback(
              readoutIdRef.current,
              'playing',
            );
          }
          resolveFirstAudioRef.current?.(true);
          resolveFirstAudioRef.current = null;
        },
      } satisfies BreezeStreamConfig);
    }
    if (epoch !== playerEpochRef.current || !assistantSpeakingRef.current) {
      player.cancel();
      return;
    }
    if (outputDeviceIdRef.current && player.setSinkId) {
      try {
        await player.setSinkId(outputDeviceIdRef.current);
      } catch (error) {
        console.warn('[cyrvis] failed to apply playback device', error);
      }
    }
    await player.start();
    if (epoch !== playerEpochRef.current || !assistantSpeakingRef.current) {
      player.cancel();
      return;
    }
    playerRef.current = player;
    clearIdleTimer();
    if (speechDeltaRef.current) {
      player.appendText(speechDeltaRef.current);
      speechDeltaRef.current = '';
    }
  }, []);

  const startPlayer = useCallback(() => {
    if (settingsRef.current.voiceTtsEnabled === false) {
      assistantSpeakingRef.current = false;
      setPlaybackActive(false);
      return;
    }
    if (playerRef.current || playerStartRef.current) {
      return;
    }
    console.info('[cyrvis] starting streaming TTS player');
    const epoch = playerEpochRef.current;
    const promise = createPlayer(epoch)
      .catch((playerError: unknown) => {
        if (epoch !== playerEpochRef.current) {
          return;
        }
        const message =
          playerError instanceof Error
            ? playerError.message
            : String(playerError);
        console.error('[cyrvis] streaming TTS failed', message);
        setError(message);
        if (readoutIdRef.current)
          window.electron.voice.reportGazePlayback(
            readoutIdRef.current,
            'failed',
            message,
          );
        assistantSpeakingRef.current = false;
        setPlaybackActive(false);
        window.electron.voice.notifyPlaybackIdle();
      })
      .finally(() => {
        if (playerStartRef.current === promise) {
          playerStartRef.current = null;
        }
      });
    playerStartRef.current = promise;
  }, [createPlayer]);

  const finishStreamingUtterance = useCallback(() => {
    if (!streamingUtteranceActiveRef.current) {
      return;
    }
    streamingUtteranceActiveRef.current = false;
    if (pendingPcmRef.current.length) {
      window.electron.voice.sendAudio(
        pendingPcmRef.current.slice().buffer as ArrayBuffer,
      );
      pendingPcmRef.current = new Uint8Array();
    }
    window.electron.voice.finishUtterance();
    bargePendingRef.current = false;
  }, []);

  const beginStreamingUtterance = useCallback(
    (preRoll: Float32Array[] = []) => {
      if (streamingUtteranceActiveRef.current || disposedRef.current) {
        return;
      }
      streamingUtteranceActiveRef.current = true;
      recordingStartedAtRef.current = Date.now();
      lastSpeechAtRef.current = recordingStartedAtRef.current;
      transcriptRef.current = '';
      pendingPcmRef.current = new Uint8Array();
      window.electron.voice.beginUtterance();

      const merged: Uint8Array[] = [];
      for (const frame of preRoll) {
        merged.push(
          floatToPcm16(downsamplePcm(frame, captureSampleRateRef.current)),
        );
      }
      if (merged.length) {
        pendingPcmRef.current = merged.reduce<Uint8Array<ArrayBuffer>>(
          (pending, chunk) => appendPcm16(pending, chunk),
          new Uint8Array() as Uint8Array<ArrayBuffer>,
        );
        flushPcmChunks();
      }
    },
    [],
  );

  const flushPcmChunks = useCallback(() => {
    const { chunks, remainder } = takePcmChunks(pendingPcmRef.current);
    pendingPcmRef.current = remainder;
    for (const chunk of chunks) {
      window.electron.voice.sendAudio(chunk.buffer as ArrayBuffer);
    }
  }, []);

  const processSamples = useCallback(
    (input: Float32Array, inputSampleRate: number) => {
      if (disposedRef.current) {
        return;
      }
      const samples = downsamplePcm(input, inputSampleRate);
      const rms = calculateRms(input);

      // Keep the local stop-word detector fed even when the assistant is
      // silent: a GUI/coding task may be running with no TTS, and "停一下"
      // must cancel it immediately instead of waiting for the final ASR text.
      // When the dedicated raw KWS stream is active, do not duplicate the
      // AEC-processed microphone into the keyword detector.
      if (!rawKeywordActiveRef.current) {
        keywordPcmRef.current = appendPcm16(
          keywordPcmRef.current,
          floatToPcm16(samples),
        );
        const keywordChunks = takePcmChunks(keywordPcmRef.current, 320 * 2);
        keywordPcmRef.current = keywordChunks.remainder;
        for (const chunk of keywordChunks.chunks) {
          window.electron.voice.sendKeywordAudio(chunk.buffer as ArrayBuffer);
        }
      }

      if (assistantSpeakingRef.current) {
        // Keep the keyword audio path above live for an explicit "停一下".
        // Energy alone cannot distinguish the user's voice from this readout
        // leaking back through the laptop mic, even in headset UI mode.
        if (Date.now() < readoutGuardUntilRef.current) {
          bargeFramesRef.current = 0;
          return;
        }
        bargePrerollRef.current = appendAudioPreroll(
          bargePrerollRef.current,
          input,
          MAX_BARGE_PREROLL_CHUNKS,
        );
        const speakerMode = audioModeRef.current === 'speaker';
        const nowDiag = Date.now();
        const playbackMs = assistantPlaybackStartedAtRef.current
          ? nowDiag - assistantPlaybackStartedAtRef.current
          : Number.POSITIVE_INFINITY;
        const speakerOnset = speakerMode && playbackMs < SPEAKER_ONSET_GUARD_MS;
        const threshold = Math.max(
          speakerMode
            ? speakerOnset
              ? SPEAKER_ONSET_BARGE_THRESHOLD
              : SPEAKER_TTS_BARGE_THRESHOLD
            : TTS_BARGE_THRESHOLD,
          noiseFloorRef.current * (speakerMode ? 4 : 2.5),
        );
        const confirmationFrames = speakerMode
          ? speakerOnset
            ? SPEAKER_ONSET_BARGE_FRAMES
            : SPEAKER_BARGE_CONFIRMATION_FRAMES
          : BARGE_CONFIRMATION_FRAMES;
        if (nowDiag - lastBargeDiagRef.current >= 500) {
          lastBargeDiagRef.current = nowDiag;
          console.log(
            '[cyrvis] barge diag',
            JSON.stringify({
              mode: audioModeRef.current,
              phase: speakerMode
                ? speakerOnset
                  ? 'onset'
                  : 'steady'
                : 'headset',
              rms: Number(rms.toFixed(4)),
              threshold: Number(threshold.toFixed(4)),
              frames: bargeFramesRef.current,
              need: confirmationFrames,
              floor: Number(noiseFloorRef.current.toFixed(4)),
            }),
          );
        }
        bargeFramesRef.current =
          rms >= threshold ? bargeFramesRef.current + 1 : 0;
        if (bargeFramesRef.current >= confirmationFrames) {
          bargeFramesRef.current = 0;
          bargePendingRef.current = true;
          const preRoll = bargePrerollRef.current;
          bargePrerollRef.current = [];
          keywordPcmRef.current = new Uint8Array();
          cancelPlayer();
          window.electron.voice.cancelSpeechOnly();
          beginStreamingUtterance(preRoll);
        }
        return;
      }

      // Omni uses the model's server-side VAD. Send every microphone chunk
      // while the assistant is silent; gating by the renderer's cascade VAD
      // truncated utterances before the server could endpoint them.
      if (settingsRef.current.voiceEngine === 'omni') {
        pendingPcmRef.current = appendPcm16(
          pendingPcmRef.current,
          floatToPcm16(samples),
        );
        const { chunks, remainder } = takePcmChunks(pendingPcmRef.current);
        pendingPcmRef.current = remainder;
        for (const chunk of chunks) {
          window.electron.voice.sendAudio(chunk.buffer as ArrayBuffer);
        }
        return;
      }

      bargeFramesRef.current = 0;
      const threshold = Math.max(0.025, noiseFloorRef.current * 3);
      if (!streamingUtteranceActiveRef.current) {
        if (rms < threshold) {
          noiseFloorRef.current = noiseFloorRef.current * 0.97 + rms * 0.03;
          speechFramesRef.current = 0;
          return;
        }
        speechFramesRef.current += 1;
        if (speechFramesRef.current >= 1) {
          speechFramesRef.current = 0;
          beginStreamingUtterance();
        }
      }

      if (!streamingUtteranceActiveRef.current) {
        return;
      }
      pendingPcmRef.current = appendPcm16(
        pendingPcmRef.current,
        floatToPcm16(samples),
      );
      if (rms >= threshold * 0.7) {
        lastSpeechAtRef.current = Date.now();
      }
      flushPcmChunks();

      const durationMs = Date.now() - recordingStartedAtRef.current;
      const silenceMs = Date.now() - lastSpeechAtRef.current;
      if (
        shouldFinishStreamingUtterance({
          durationMs,
          silenceMs,
          configuredSilenceMs: bargePendingRef.current
            ? BARGE_ENDPOINT_SILENCE_MS
            : settingsRef.current.voiceSilenceTimeoutMs ||
              MIN_ENDPOINT_SILENCE_MS,
          transcript: transcriptRef.current,
        })
      ) {
        finishStreamingUtterance();
      }
    },
    [
      beginStreamingUtterance,
      cancelPlayer,
      finishStreamingUtterance,
      flushPcmChunks,
    ],
  );

  const refreshOutputDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices
      .filter((device) => device.kind === 'audiooutput' && device.deviceId)
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || 'Audio output',
      }));
    setOutputDevices(outputs);
    return outputs;
  }, []);

  const setOutputDevice = useCallback(
    async (deviceId: string, devices?: OutputDeviceOption[]) => {
      outputDeviceIdRef.current = deviceId;
      setSelectedOutputId(deviceId);
      localStorage.setItem('cyrvis.outputDeviceId', deviceId);
      const output = (devices ?? outputDevices).find(
        (item) => item.deviceId === deviceId,
      );
      if (output) {
        await window.electron.voice.setOutput(output.label);
        await legacyPlayerRef.current?.setSinkId(deviceId);
      }
      try {
        await Promise.all([
          playerRef.current?.setSinkId?.(deviceId),
          legacyPlayerRef.current?.setSinkId?.(deviceId),
        ]);
      } catch (error) {
        console.warn('[cyrvis] failed to switch playback device', error);
      }
    },
    [outputDevices],
  );

  const testOutputDevice = useCallback(async (deviceId: string) => {
    const sampleRate = 24_000;
    const frames = sampleRate;
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const write = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, frames * 2, true);
    for (let index = 0; index < frames; index += 1) {
      const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.2;
      view.setInt16(44 + index * 2, sample * 0x7fff, true);
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    const audio = new Audio(url);
    const sinkable = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    try {
      if (deviceId && sinkable.setSinkId) {
        await sinkable.setSinkId(deviceId);
      }
      await audio.play();
    } finally {
      setTimeout(() => {
        audio.pause();
        URL.revokeObjectURL(url);
      }, 1_200);
    }
  }, []);

  const selectAudioMode = useCallback(
    async (mode: 'headset' | 'speaker') => {
      audioModeRef.current = mode;
      bargeFramesRef.current = 0;
      setAudioModeState(mode);
      localStorage.setItem('cyrvis.audioMode', mode);
      await window.electron.voice.setAudioMode(mode);
      const outputs = await refreshOutputDevices();
      const builtin = outputs.find(
        (output) =>
          output.deviceId !== 'default' &&
          /macbook.*(扬声器|speakers)|built-?in/i.test(output.label),
      );
      if (mode === 'speaker' && builtin) {
        await setOutputDevice(builtin.deviceId, outputs);
      } else if (mode === 'headset') {
        const headset =
          outputs.find(
            (output) =>
              output.deviceId !== 'default' &&
              /cc ultimate|airpods|耳机|headset|bluetooth/i.test(output.label),
          ) ?? outputs.find((output) => output.deviceId === 'default');
        if (headset) {
          await setOutputDevice(headset.deviceId, outputs);
        }
      }
    },
    [refreshOutputDevices, setOutputDevice],
  );

  const toggleAudioMode = useCallback(
    () => selectAudioMode(audioMode === 'speaker' ? 'headset' : 'speaker'),
    [audioMode, selectAudioMode],
  );

  const stopCapture = useCallback(async () => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    await captureContextRef.current?.close();
    captureContextRef.current = null;
    rawProcessorRef.current?.disconnect();
    rawProcessorRef.current = null;
    rawSourceRef.current?.disconnect();
    rawSourceRef.current = null;
    rawGainRef.current?.disconnect();
    rawGainRef.current = null;
    rawStreamRef.current?.getTracks().forEach((track) => track.stop());
    rawStreamRef.current = null;
    await rawCaptureContextRef.current?.close();
    rawCaptureContextRef.current = null;
    rawKeywordPcmRef.current = new Uint8Array();
    rawKeywordActiveRef.current = false;
    streamingUtteranceActiveRef.current = false;
    bargePendingRef.current = false;
    pendingPcmRef.current = new Uint8Array();
    setMicReady(false);
  }, []);

  const startCapture = useCallback(async () => {
    if (mediaStreamRef.current) {
      return;
    }
    // Always keep AEC on the main microphone. The saved audio mode is loaded
    // asynchronously, so audioModeRef may still be the initial "headset" when
    // capture starts; gating AEC on that value opened speaker mode without
    // echo cancellation and let TTS echo trigger the immediate energy barge.
    // Short stop words are handled by the dedicated raw KWS stream below.
    const stream = await openMicrophoneStream(true);
    mediaStreamRef.current = stream;
    const audioContext = new AudioContext();
    captureContextRef.current = audioContext;
    captureSampleRateRef.current = audioContext.sampleRate;
    const captureTrack = stream.getAudioTracks()[0];
    console.log('[cyrvis] mic capture ready', {
      label: captureTrack?.label || '',
      deviceId: captureTrack?.getSettings().deviceId || '',
      sampleRate: audioContext.sampleRate,
      echoCancellation: captureTrack?.getSettings().echoCancellation,
    });
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    sourceRef.current = source;
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    processor.onaudioprocess = (event) => {
      processSamples(
        event.inputBuffer.getChannelData(0),
        audioContext.sampleRate,
      );
    };
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    silentGainRef.current = silentGain;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
    captureTrack?.addEventListener('ended', () => {
      setMicReady(false);
      setError('Microphone disconnected');
      window.electron.voice.notifyCaptureError('Microphone disconnected');
    });

    // Dedicated raw mic stream for KWS only. The main stream may be AEC
    // processed in speaker mode, which suppresses a short "停一下"; KWS must
    // hear the raw microphone while ASR keeps AEC.
    try {
      const rawStream = await openMicrophoneStream(false);
      rawStreamRef.current = rawStream;
      const rawContext = new AudioContext();
      rawCaptureContextRef.current = rawContext;
      await rawContext.resume();
      const rawSource = rawContext.createMediaStreamSource(rawStream);
      rawSourceRef.current = rawSource;
      const rawProcessor = rawContext.createScriptProcessor(4096, 1, 1);
      rawProcessorRef.current = rawProcessor;
      rawProcessor.onaudioprocess = (event) => {
        const rawSamples = downsamplePcm(
          event.inputBuffer.getChannelData(0),
          rawContext.sampleRate,
        );
        rawKeywordPcmRef.current = appendPcm16(
          rawKeywordPcmRef.current,
          floatToPcm16(rawSamples),
        );
        const rawChunks = takePcmChunks(rawKeywordPcmRef.current, 320 * 2);
        rawKeywordPcmRef.current = rawChunks.remainder;
        for (const chunk of rawChunks.chunks) {
          window.electron.voice.sendKeywordAudio(chunk.buffer as ArrayBuffer);
        }
      };
      const rawGain = rawContext.createGain();
      rawGain.gain.value = 0;
      rawGainRef.current = rawGain;
      rawSource.connect(rawProcessor);
      rawProcessor.connect(rawGain);
      rawGain.connect(rawContext.destination);
      rawKeywordActiveRef.current = true;
      console.log('[cyrvis] raw KWS capture ready');
    } catch (rawError) {
      rawKeywordActiveRef.current = false;
      console.warn('[cyrvis] raw KWS capture failed', rawError);
    }

    setMicReady(true);
    setError(null);
    window.electron.voice.notifyCaptureReady(
      captureTrack?.label || 'renderer microphone',
    );
    await refreshOutputDevices();
  }, [processSamples, refreshOutputDevices]);

  const start = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    setError(null);
    try {
      const result = await window.electron.voice.start();
      if (!result?.ok) throw new Error(result?.error || 'Voice is unavailable');
      await startCapture();
    } catch (captureError) {
      const message =
        captureError instanceof Error
          ? captureError.message
          : String(captureError);
      console.error('[cyrvis] voice start failed', message);
      setError(message);
      setMicReady(false);
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [startCapture]);

  const stop = useCallback(async () => {
    finishStreamingUtterance();
    cancelPlayer();
    await stopCapture();
    setThinking(false);
    await window.electron.voice.stop();
  }, [cancelPlayer, finishStreamingUtterance, stopCapture]);

  const restartCapture = useCallback(async () => {
    await stopCapture();
    await startCapture();
  }, [startCapture, stopCapture]);

  const interrupt = useCallback(() => {
    cancelPlayer();
    window.electron.voice.bargeIn();
  }, [cancelPlayer]);

  useEffect(() => {
    if (voiceOwner) {
      console.warn('[cyrvis] duplicate voice instance ignored');
      return;
    }
    voiceOwner = ownerRef.current;
    const owner = ownerRef.current;
    disposedRef.current = false;

    void window.electron.voice.getPtt().then((next) => setPtt(next));
    void window.electron.voice.getAudioMode().then(async ({ mode }) => {
      const saved = localStorage.getItem('cyrvis.audioMode');
      const nextMode =
        saved === 'speaker' || saved === 'headset' ? saved : mode;
      audioModeRef.current = nextMode;
      bargeFramesRef.current = 0;
      setAudioModeState(nextMode);
      await window.electron.voice.setAudioMode(nextMode);
      const outputs = await refreshOutputDevices();
      const savedOutputId = localStorage.getItem('cyrvis.outputDeviceId');
      const output = outputs.find((item) => item.deviceId === savedOutputId);
      if (output) {
        setSelectedOutputId(output.deviceId);
        outputDeviceIdRef.current = output.deviceId;
      } else if (nextMode === 'speaker') {
        const builtin = outputs.find((item) =>
          /macbook.*(扬声器|speakers)|built-?in/i.test(item.label),
        );
        if (builtin) {
          setSelectedOutputId(builtin.deviceId);
          outputDeviceIdRef.current = builtin.deviceId;
          localStorage.setItem('cyrvis.outputDeviceId', builtin.deviceId);
          await window.electron.voice.setOutput(builtin.label);
        }
      }
    });

    const cleanups = [
      window.electron.voice.onPttState((next) => setPtt(next)),
      window.electron.voice.onError(({ message }) => {
        setThinking(false);
        setError(message);
        cancelPlayer(true);
      }),
      window.electron.voice.onSpeechStarted(() => {
        setTranscript('');
        if (!assistantSpeakingRef.current) {
          assistantTextStartedRef.current = false;
          setThinking(false);
        }
      }),
      window.electron.voice.onSpeechStopped(() => undefined),
      window.electron.voice.onThinking(() => setThinking(true)),
      window.electron.voice.onAudio((pcm16) => {
        if (settingsRef.current.voiceEngine !== 'omni' || !pcm16.length) {
          return;
        }
        // Only treat the assistant as speaking once real audio arrives. The
        // response.created event fires before the model has processed the
        // user's own utterance, so arming the barge there cancelled responses
        // while the user was still finishing their sentence.
        if (!assistantSpeakingRef.current) {
          assistantPlaybackStartedAtRef.current = Date.now();
        }
        assistantSpeakingRef.current = true;
        setPlaybackActive(true);
        if (!legacyPlayerRef.current) {
          const epoch = playerEpochRef.current;
          const id = readoutIdRef.current;
          legacyPlayerRef.current = new WebAudioStreamPlayer(
            finishPlayback,
            (audioError) => {
              if (epoch !== playerEpochRef.current) return;
              const message =
                audioError instanceof Error
                  ? audioError.message
                  : String(audioError);
              if (id)
                window.electron.voice.reportGazePlayback(id, 'failed', message);
              setError(message);
              cancelPlayer(true);
            },
            (samples, startedAt) => {
              if (epoch !== playerEpochRef.current) return;
              window.electron.voice.sendPlaybackReference(
                samples.slice().buffer as ArrayBuffer,
                startedAt,
              );
              if (id && !readoutPlayingRef.current) {
                readoutPlayingRef.current = true;
                window.electron.voice.reportGazePlayback(id, 'playing');
              }
            },
          );
          const player = legacyPlayerRef.current;
          if (outputDeviceIdRef.current) {
            void player.setSinkId(outputDeviceIdRef.current).catch((error) => {
              if (epoch !== playerEpochRef.current) return;
              const message =
                error instanceof Error ? error.message : String(error);
              if (id)
                window.electron.voice.reportGazePlayback(id, 'failed', message);
              setError(message);
              cancelPlayer(true);
            });
          }
        }
        legacyPlayerRef.current.play(pcm16);
      }),
      window.electron.voice.onResponseStarted((info) => {
        assistantTextStartedRef.current = false;
        console.info('[cyrvis] response started', {
          engine: settingsRef.current.voiceEngine,
          ttsProvider: settingsRef.current.voiceTtsProvider,
        });
        cancelPlayer();
        readoutIdRef.current = info?.readoutId;
        playerEpochRef.current += 1;
        if (settingsRef.current.voiceEngine !== 'omni') {
          assistantSpeakingRef.current = true;
          assistantPlaybackStartedAtRef.current = Date.now();
        }
        speechDeltaRef.current = '';
        speechDeltaSeenRef.current = false;
        firstAudioPromiseRef.current = new Promise<boolean>((resolve) => {
          resolveFirstAudioRef.current = resolve;
        });
        setThinking(false);
        if (settingsRef.current.voiceEngine !== 'omni') {
          setPlaybackActive(true);
        }
        if (settingsRef.current.voiceEngine === 'omni') {
          return;
        }
        startPlayer();
        clearIdleTimer();
        assistantIdleTimerRef.current = setTimeout(() => {
          if (assistantSpeakingRef.current && !playerRef.current) {
            finishPlayback();
          }
        }, 120_000);
      }),
      window.electron.voice.onResponseStopped(() => {
        setThinking(false);
        cancelPlayer(true);
      }),
      window.electron.voice.onResponseDone(() => {
        void (async () => {
          if (settingsRef.current.voiceEngine === 'omni') {
            if (legacyPlayerRef.current) {
              legacyPlayerRef.current.finish();
            } else {
              finishPlayback();
            }
            return;
          }
          if (playerStartRef.current) {
            await playerStartRef.current;
          }
          const player = playerRef.current;
          if (!player) {
            finishPlayback();
            return;
          }
          const firstAudio = await waitForAudioStart(
            firstAudioPromiseRef.current ?? Promise.resolve(false),
            settingsRef.current.voiceTtsProvider === 'qwen-tts-realtime'
              ? 15_000
              : 4_000,
          );
          if (!firstAudio) {
            player.cancel();
            playerRef.current = null;
            setError('语音首包超时，请检查 TTS API 或本地服务。');
            finishPlayback();
            return;
          }
          try {
            await player.finish();
          } catch (finishError) {
            console.warn('[cyrvis] streaming TTS finish failed', finishError);
          } finally {
            playerRef.current = null;
            finishPlayback();
          }
        })();
      }),
      window.electron.voice.onTranscript(({ text, final }) => {
        transcriptRef.current = text;
        setTranscript(text);
        if (final) {
          if (text.trim() && !assistantTextStartedRef.current) {
            setAssistantText('');
          }
          if (!text.trim()) {
            setThinking(false);
          }
        }
      }),
      window.electron.voice.onAssistantText(({ text, final }) => {
        setThinking(false);
        setAssistantText((current) => {
          if (!assistantTextStartedRef.current) {
            assistantTextStartedRef.current = true;
            return text;
          }
          return final ? text : current + text;
        });
      }),
      window.electron.voice.onSpeechText(({ text, final }) => {
        if (settingsRef.current.voiceEngine === 'omni') {
          return;
        }
        if (final) {
          if (!speechDeltaSeenRef.current && text.trim()) {
            speechDeltaRef.current += text;
            startPlayer();
          }
          return;
        }
        speechDeltaSeenRef.current = true;
        speechDeltaRef.current += text;
        if (playerRef.current) {
          playerRef.current.appendText(text);
          speechDeltaRef.current = '';
        }
      }),
      window.electron.voice.onState((next) => {
        readoutGuardUntilRef.current = next.readoutGuardUntil || 0;
        setState(next as VoiceUiState);
      }),
      window.electron.voice.onWake(() => {
        setTranscript('');
        setAssistantText('');
        assistantTextStartedRef.current = false;
      }),
      window.electron.voice.onSleep(() => setThinking(false)),
      window.electron.voice.onAudioMode(({ mode }) => {
        audioModeRef.current = mode;
        bargeFramesRef.current = 0;
        setAudioModeState(mode);
      }),
      window.electron.voice.onCaptureReady(() => {
        setError(null);
        setMicReady(true);
      }),
      window.electron.voice.onCaptureError(({ message }) => {
        setError(message);
        setMicReady(false);
      }),
    ];

    if (!window.electron.voice.isTestMode) {
      void start();
    }

    const deviceChange = () => {
      if (!mediaStreamRef.current) return;
      console.log('[cyrvis] audio device changed; restarting capture');
      void restartCapture().catch((restartError) => {
        console.warn('[cyrvis] mic restart failed', restartError);
      });
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', deviceChange);

    return () => {
      disposedRef.current = true;
      if (voiceOwner === owner) {
        voiceOwner = null;
      }
      navigator.mediaDevices?.removeEventListener?.(
        'devicechange',
        deviceChange,
      );
      clearIdleTimer();
      cleanups.forEach((cleanup) => cleanup());
      cancelPlayer();
      void stopCapture();
    };
  }, [
    cancelPlayer,
    finishPlayback,
    refreshOutputDevices,
    restartCapture,
    start,
    startPlayer,
    stopCapture,
  ]);

  return {
    state,
    transcript,
    assistantText,
    micReady,
    thinking,
    connecting,
    playbackActive,
    audioMode,
    outputDevices,
    selectedOutputId,
    setOutputDevice,
    testOutputDevice,
    error,
    ptt,
    start,
    stop,
    togglePtt: window.electron.voice.togglePtt,
    interrupt,
    toggleAudioMode,
    selectAudioMode,
    forceAwake: window.electron.voice.forceAwake,
    sleep: window.electron.voice.sleep,
    cancelTask: window.electron.voice.cancelTask,
  };
}
