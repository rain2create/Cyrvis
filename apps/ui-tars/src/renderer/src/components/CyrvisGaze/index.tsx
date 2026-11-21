import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { GazeInspection } from '@main/cyrvis/gaze/inspector';
import type { ProactiveGazeStatus } from '@main/cyrvis/gaze/proactive';
import type { GazeObjectStatus } from '@main/cyrvis/gaze/object-tracker';
import {
  AdaptiveGazeFilter,
  FaceGate,
  TargetSampler,
  TRAIN_TARGETS,
  VALIDATE_TARGETS,
  SAMPLES_PER_TARGET,
  TRAINING_BUFFER_SIZE,
  trainingCoverage,
  CORRECTION_TARGETS,
  fitScreenCorrection,
  applyScreenCorrection,
  type ScreenCorrection,
  summarizeValidation,
  type Point,
  type ValidationPoint,
} from '@main/cyrvis/gaze/processing';
declare global {
  interface Window {
    webgazer: any;
  }
}
type Stage =
  | 'off'
  | 'loading'
  | 'training'
  | 'correction'
  | 'validation'
  | 'report'
  | 'tracking';
type Report = ReturnType<typeof summarizeValidation> & {
  baseline: ReturnType<typeof summarizeValidation>;
  correction: ScreenCorrection | null;
};
const invoke = (name: string, ...args: unknown[]) =>
  window.electron.ipcRenderer.invoke(`cyrvis:gaze:${name}`, ...args);
let scriptPromise: Promise<void> | null = null;
function loadLibrary() {
  if (window.webgazer) return Promise.resolve();
  if (!scriptPromise)
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './gaze/webgazer.js';
      script.onload = () => resolve();
      script.onerror = () => {
        scriptPromise = null;
        script.remove();
        reject(Error('眼动库加载失败'));
      };
      document.head.appendChild(script);
    });
  return scriptPromise;
}
const panelStyle = {
  position: 'fixed',
  top: 55,
  right: 18,
  width: 350,
  zIndex: 9000,
  background: 'white',
  color: '#223',
  border: '1px solid #aaa',
  padding: 16,
  borderRadius: 12,
  fontSize: 12,
  maxHeight: 'calc(100vh - 100px)',
  overflowY: 'auto',
} as const;
export default function CyrvisGaze() {
  const [open, setOpen] = useState(false),
    [stage, setStage] = useState<Stage>('off'),
    [index, setIndex] = useState(0),
    [count, setCount] = useState(0),
    [note, setNote] = useState('摄像头估计，主屏幕校准；非执行授权'),
    [report, setReport] = useState<Report | null>(null),
    [cursorVisible, setCursorVisible] = useState(true),
    [inspection, setInspection] = useState<GazeInspection>({
      enabled: false,
      phase: 'idle',
    }),
    [countdown, setCountdown] = useState(false);
  const [proactive, setProactive] = useState<ProactiveGazeStatus>({
    enabled: false,
    phase: 'off',
    dwellMs: 4500,
    progress: 0,
  });
  const [objects, setObjects] = useState<GazeObjectStatus>({
    enabled: true,
    phase: 'searching',
    progress: 0,
    objects: 0,
  });
  const session = useRef(0),
    state = useRef<Stage>('off'),
    targetIndex = useRef(0),
    enabled = useRef(true),
    sharing = useRef(false),
    size = useRef({ width: 0, height: 0 });
  const sampler = useRef(new TargetSampler()),
    gate = useRef(new FaceGate()),
    filter = useRef(new AdaptiveGazeFilter());
  const correction = useRef<ScreenCorrection | null>(null),
    correctionPoints = useRef<ValidationPoint[]>([]);
  const quickDemo = useRef(false);
  const validation = useRef<ValidationPoint[]>([]),
    currentValidation = useRef<Point[]>([]),
    recent = useRef<{ point: Point; at: number }[]>([]),
    lastCursor = useRef(0),
    lastContext = useRef(0),
    lastUi = useRef(0);
  const moveStage = (next: Stage) => {
    state.current = next;
    setStage(next);
  };
  const outputActive = useRef(true);
  const clearOutput = () => {
    if (!outputActive.current) return;
    outputActive.current = false;
    void invoke('cursor', null).catch(() => {});
    void invoke('update', null).catch(() => {});
  };
  const resetProcessing = () => {
    gate.current.reset();
    filter.current.reset();
    recent.current = [];
    lastCursor.current = 0;
    lastContext.current = 0;
  };
  function stop() {
    session.current++;
    moveStage('off');
    sharing.current = false;
    void invoke('inspect-enabled', false).catch(() => {});
    try {
      window.webgazer?.end();
    } catch {}
    outputActive.current = true;
    clearOutput();
    resetProcessing();
  }
  useEffect(() => {
    const invalidate = () => {
      if (state.current === 'off' || state.current === 'loading') return;
      // Tracking uses the frozen primary-screen calibration coordinates,
      // not the current workbench viewport. Returning from a task, restoring
      // or resizing the workbench must not end the camera session.
      if (state.current === 'tracking') return;
      sharing.current = false;
      void invoke('inspect-enabled', false).catch(() => {});
      moveStage('off');
      session.current++;
      window.webgazer?.end();
      clearOutput();
      resetProcessing();
      setNote('校准过程中窗口尺寸发生变化，请重新校准。');
    };
    window.addEventListener('resize', invalidate);
    return () => {
      window.removeEventListener('resize', invalidate);
      stop();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () =>
      void Promise.all([
        invoke('inspection-status'),
        invoke('proactive-status'),
        invoke('object-status'),
      ])
        .then(([result, nextProactive, nextObjects]) => {
          if (active) {
            setInspection(result);
            setProactive(nextProactive);
            setObjects(nextObjects);
          }
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  function beginTarget(
    nextStage: 'training' | 'correction' | 'validation',
    nextIndex: number,
  ) {
    targetIndex.current = nextIndex;
    setIndex(nextIndex);
    setCount(0);
    currentValidation.current = [];
    sampler.current.reset(performance.now());
    gate.current.reset();
    moveStage(nextStage);
  }
  function finishTarget() {
    const i = targetIndex.current;
    if (state.current === 'training') {
      if (i + 1 < TRAIN_TARGETS.length) beginTarget('training', i + 1);
      else {
        const stored = window.webgazer.getRegression()[0].getData();
        const coverage = trainingCoverage(
          stored,
          size.current.width,
          size.current.height,
        );
        if (!coverage.complete) {
          stop();
          setOpen(true);
          setNote(
            `训练数据不完整，已停止验证。九个位置保留样本数：${coverage.counts.join(' / ')}；请重启后重新校准。`,
          );
          return;
        }
        if (quickDemo.current) {
          track(true);
          setNote(
            '九点采样完成，已进入AI看屏演示（未做精度验证）。隐藏工作台后，看向目标，按 ⌘/Ctrl+Alt+I。',
          );
          return;
        }
        correctionPoints.current = [];
        beginTarget('correction', 0);
      }
    } else if (state.current === 'correction') {
      correctionPoints.current.push({
        target: CORRECTION_TARGETS[i],
        samples: [...currentValidation.current],
      });
      if (i + 1 < CORRECTION_TARGETS.length) beginTarget('correction', i + 1);
      else {
        correction.current = fitScreenCorrection(
          correctionPoints.current,
          size.current.width,
          size.current.height,
        );
        validation.current = [];
        beginTarget('validation', 0);
      }
    } else {
      validation.current.push({
        target: VALIDATE_TARGETS[i],
        samples: [...currentValidation.current],
      });
      if (i + 1 < VALIDATE_TARGETS.length) beginTarget('validation', i + 1);
      else {
        const { width, height } = size.current;
        const baseline = summarizeValidation(validation.current, width, height);
        const corrected = validation.current.map((v) => ({
          ...v,
          samples: v.samples.map((p) =>
            applyScreenCorrection(p, correction.current, width, height),
          ),
        }));
        const result = summarizeValidation(corrected, width, height);
        setReport({ ...result, baseline, correction: correction.current });
        sharing.current = false;
        clearOutput();
        resetProcessing();
        moveStage('report');
        setNote(
          '验证完成：补偿由单独的校准点拟合，评分使用独立验证点；显示补偿前后误差，均未使用时间平滑。',
        );
      }
    }
  }
  function onFrame(data: any) {
    const current = state.current;
    if (!['training', 'correction', 'validation', 'tracking'].includes(current))
      return;
    const now = performance.now(),
      w = window.webgazer,
      patches = w.getCurrentEyeFeatures?.();
    const quality = gate.current.update(
      w.getTracker()?.getPositions?.() || null,
      !!patches?.left && !!patches?.right,
      now,
    );
    const prediction =
      data && Number.isFinite(data.x) && Number.isFinite(data.y)
        ? { x: data.x, y: data.y }
        : null;
    if (
      current === 'training' ||
      current === 'correction' ||
      current === 'validation'
    ) {
      const valid = quality && (current === 'training' || !!prediction);
      if (now - lastUi.current > 250) {
        lastUi.current = now;
        setNote(
          !quality
            ? '请正视摄像头、睁开眼睛并保持头部稳定。'
            : current !== 'training' && !prediction
              ? '尚无有效预测，请重新校准或检查摄像头。'
              : '保持注视圆点，正在自动采样，无需点击。',
        );
      }
      if (!sampler.current.tick(now, valid)) return;
      if (current === 'training') {
        const p = TRAIN_TARGETS[targetIndex.current];
        w.recordScreenPosition(
          p.x * size.current.width,
          p.y * size.current.height,
          'click',
        );
      } else if (prediction) currentValidation.current.push(prediction);
      setCount(sampler.current.collected);
      if (sampler.current.collected === SAMPLES_PER_TARGET) finishTarget();
      return;
    }
    if (!quality || !prediction) {
      filter.current.reset();
      recent.current = [];
      clearOutput();
      return;
    }
    const { width, height } = size.current;
    const adjusted = applyScreenCorrection(
      prediction,
      correction.current,
      width,
      height,
    );
    if (
      adjusted.x < 0 ||
      adjusted.y < 0 ||
      adjusted.x > width ||
      adjusted.y > height
    ) {
      clearOutput();
      return;
    }
    const smooth = filter.current.update(adjusted, now);
    if (enabled.current && now - lastCursor.current >= 50) {
      lastCursor.current = now;
      outputActive.current = true;
      void invoke('cursor', {
        x: smooth.x / width,
        y: smooth.y / height,
        timestamp: Date.now(),
      }).catch(() => {});
    }
    recent.current = [
      ...recent.current.filter((v) => now - v.at < 450),
      { point: adjusted, at: now },
    ];
    if (!sharing.current || now - lastContext.current < 500) return;
    lastContext.current = now;
    const points = recent.current;
    if (points.length < 3) {
      void invoke('update', null);
      return;
    }
    outputActive.current = true;
    void invoke('update', {
      x: smooth.x / width,
      y: smooth.y / height,
      timestamp: Date.now(),
    }).catch(() => {});
  }
  async function start(demo = false) {
    if (state.current === 'loading') return;
    stop();
    quickDemo.current = demo;
    const id = ++session.current;
    moveStage('loading');
    setReport(null);
    correction.current = null;
    correctionPoints.current = [];
    setCount(0);
    setIndex(0);
    setOpen(true);
    setNote('加载本地眼动模型并启动摄像头…');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await loadLibrary();
      if (id !== session.current) return;
      const w = window.webgazer;
      w.params.faceMeshSolutionPath = new URL(
        './gaze/face_mesh/',
        location.href,
      ).href;
      w.params.calibrationBufferSize = TRAINING_BUFFER_SIZE;
      w.saveDataAcrossSessions(false);
      w.setRegression('ridge');
      await w.clearData();
      if (id !== session.current) return;
      w.showPredictionPoints(false);
      w.applyKalmanFilter(false);
      w.setGazeListener(onFrame);
      await invoke('calibrate-screen');
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (id !== session.current) return;
      size.current = { width: innerWidth, height: innerHeight };
      await Promise.race([
        w.begin(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(Error('摄像头初始化超过45秒，请检查权限')),
            45000,
          );
        }),
      ]);
      if (id !== session.current) {
        w.end();
        return;
      }
      w.removeMouseEventListeners();
      w.showVideoPreview(false);
      w.showFaceOverlay(false);
      w.showFaceFeedbackBox(false);
      resetProcessing();
      beginTarget('training', 0);
    } catch (e) {
      if (id === session.current) {
        stop();
        setNote(String(e));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  function track(allowShare: boolean) {
    sharing.current = allowShare;
    void invoke('inspect-enabled', allowShare)
      .then(setInspection)
      .catch((e) => setNote(String(e)));
    resetProcessing();
    moveStage('tracking');
    setNote(
      allowShare
        ? 'AI看屏已开启：看向主屏幕的目标，说“我在看什么”。位置为估计值，每次提问发送一张区域截图。'
        : '低精度预览：光标可见，但不向AI共享注视位置。',
    );
  }
  const isTarget =
    stage === 'training' || stage === 'correction' || stage === 'validation';
  const target =
    (stage === 'validation'
      ? VALIDATE_TARGETS
      : stage === 'correction'
        ? CORRECTION_TARGETS
        : TRAIN_TARGETS)[index] || TRAIN_TARGETS[0];
  return (
    <>
      <button
        className="non-draggable-area"
        aria-expanded={open}
        aria-controls="cyrvis-gaze-panel"
        style={{
          position: 'fixed',
          top: 12,
          right: 18,
          zIndex: 9000,
          background: 'white',
          border: '1px solid #aaa',
          borderRadius: 10,
          padding: 8,
        }}
        onClick={() => setOpen(!open)}
      >
        ◉ 眼动 {stage !== 'off' ? '开启' : ''}
      </button>
      {open && (
        <div
          id="cyrvis-gaze-panel"
          className="non-draggable-area"
          style={panelStyle}
        >
          <p role="status">{note}</p>
          <p>
            摄像头本地处理，桌面及其他应用均可识别。手动看屏在提问时发送区域截图；开启主动提醒后，稳定注视也会触发区域截图，发送到
            Settings 配置的视觉模型。
          </p>
          <p>
            眼动独立运行：“停止任务”仅停止桌面操作，不关闭眼动。点击“关闭摄像头与共享”才结束眼动。
          </p>
          <button
            onClick={() => start(true)}
            disabled={stage === 'loading'}
            style={{
              background: '#205f51',
              color: 'white',
              borderRadius: 8,
              padding: 8,
            }}
          >
            快速体验AI看屏
          </button>
          <p>
            只做九点自动采样，随后直接开始演示；不要求通过精度验证。提问时发送区域截图。
          </p>
          <button onClick={() => start()} disabled={stage === 'loading'}>
            完整校准与精度验证
          </button>{' '}
          <button onClick={stop}>关闭摄像头与共享</button>
          <p>
            <label>
              <input
                type="checkbox"
                checked={cursorVisible}
                onChange={(e) => {
                  enabled.current = e.target.checked;
                  setCursorVisible(e.target.checked);
                  void invoke('cursor-enabled', e.target.checked);
                }}
              />{' '}
              桌面对象高亮 / 光标
            </label>
            （⌘/Ctrl+Alt+G 隐藏/显示）
          </p>
          <button
            onClick={async () => {
              try {
                outputActive.current = true;
                const result = await invoke('cursor-preview');
                setNote(
                  result.visible
                    ? '独立光标居中显示5秒（测试位置，非眼动）。'
                    : '光标窗口未显示，请重试。',
                );
              } catch (e) {
                setNote(String(e));
              }
            }}
          >
            测试桌面光标（居中5秒，非眼动）
          </button>
          <section aria-label="对象吸附设置">
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={objects.enabled}
                  onChange={async (e) => {
                    try {
                      setObjects(
                        await invoke('object-configure', e.target.checked),
                      );
                    } catch (error) {
                      setNote(String(error));
                    }
                  }}
                />{' '}
                对象吸附（本地识别）
              </label>
            </p>
            <p>
              黄色框表示候选对象，持续注视后变为绿色锁定框；小幅抖动不会跳到旁边。选错时移开视线，再看向目标中央。不会自动点击。
            </p>
            <p>
              识别在本机完成；应用对象不可读时，本地截图检测图像区域和文字，不发送到模型。AI看屏与主动提醒需另行开启。
            </p>
            {!objects.enabled && stage === 'tracking' && (
              <p role="status">
                对象吸附已关闭，当前仅显示绿色位置光标；勾选上方“对象吸附”可显示对象框。
              </p>
            )}
            {objects.enabled && stage === 'tracking' && (
              <>
                <p role="status">
                  {objects.phase === 'locked'
                    ? `已锁定：${objects.target?.label || '界面对象'}`
                    : objects.phase === 'candidate'
                      ? `候选：${objects.target?.label || '界面对象'}`
                      : objects.phase === 'ambiguous'
                        ? '附近有多个候选，请看向目标中央'
                        : objects.objects > 0
                          ? `本地识别到 ${objects.objects} 个对象，请看向目标中央以吸附。`
                          : '尚未识别到附近对象，正在本地扫描…'}
                </p>
                <progress
                  aria-label="对象注视锁定进度"
                  max={1}
                  value={objects.progress}
                />
                {objects.error && <p>{objects.error}</p>}
              </>
            )}
          </section>
          <section aria-label="注视主动提醒设置">
            {stage !== 'tracking' && (
              <p>完成上面的九点采样后，可在这里开启注视主动提醒。</p>
            )}
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={proactive.enabled}
                  disabled={stage !== 'tracking' || !inspection.enabled}
                  onChange={async (e) => {
                    try {
                      setProactive(
                        await invoke('proactive-configure', {
                          enabled: e.target.checked,
                          dwellMs: proactive.dwellMs,
                        }),
                      );
                    } catch (error) {
                      setNote(String(error));
                    }
                  }}
                />{' '}
                注视主动提醒
              </label>{' '}
              <select
                aria-label="主动提醒注视时长"
                value={proactive.dwellMs}
                onChange={async (e) => {
                  try {
                    setProactive(
                      await invoke('proactive-configure', {
                        enabled: proactive.enabled,
                        dwellMs: Number(e.target.value),
                      }),
                    );
                  } catch (error) {
                    setNote(String(error));
                  }
                }}
              >
                <option value={4500}>约4.5秒</option>
                <option value={6000}>约6秒</option>
                <option value={9000}>约9秒</option>
              </select>
            </p>
            {proactive.enabled && (
              <div>
                <p>
                  稳定注视后简短询问下一步，提供 2–3
                  个选项；你选择后才操作。新对象最短间隔8秒，同一对象45秒内不重复。
                </p>
                <p>
                  触发截图后可以移开视线；助手识别当时的对象，语音空闲时询问你的需求。任务执行期间暂缓提醒，结束后自动恢复。
                </p>
                <p role="status">
                  {proactive.phase === 'watching'
                    ? proactive.detail || '等待稳定注视…'
                    : proactive.phase === 'waiting'
                      ? proactive.detail || '等待语音空闲或开启语音…'
                      : proactive.phase === 'inspecting'
                        ? '正在理解你注视的内容…'
                        : proactive.phase === 'cooldown'
                          ? proactive.detail || '暂缓中，稍后继续识别'
                          : proactive.error || ''}
                </p>
                {proactive.phase === 'cooldown' && !!proactive.retryInMs && (
                  <p>
                    还需 {Math.ceil(proactive.retryInMs / 1000)}{' '}
                    秒；眼动仍在运行。
                  </p>
                )}
                <progress
                  aria-label="持续注视进度"
                  max={1}
                  value={proactive.progress}
                />
                {proactive.error && <p>{proactive.error}</p>}
                {proactive.suggestion && (
                  <div>
                    <p>{proactive.suggestion.speech}</p>
                    {[
                      ...proactive.suggestion.actions,
                      { kind: 'dismiss', label: '暂时不要' },
                    ].map((action) => (
                      <button
                        key={action.kind}
                        style={{
                          border: '1px solid #bcc',
                          borderRadius: 8,
                          padding: '6px 8px',
                          margin: 3,
                        }}
                        onClick={async () => {
                          try {
                            const result = await invoke(
                              'proactive-action',
                              proactive.suggestion!.id,
                              action.kind,
                            );
                            setNote(
                              result.ok
                                ? '已收到你的选择，交给助手处理。'
                                : result.message,
                            );
                            setProactive(await invoke('proactive-status'));
                          } catch (error) {
                            setNote(String(error));
                          }
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
          {stage === 'tracking' && (
            <>
              <p>
                <label>
                  <input
                    type="checkbox"
                    checked={inspection.enabled}
                    onChange={async (e) => {
                      const enabled = e.target.checked;
                      sharing.current = enabled;
                      setInspection(await invoke('inspect-enabled', enabled));
                    }}
                  />{' '}
                  AI看屏（允许发送区域截图）
                </label>
              </p>
              <p>
                说“我在看什么”，或按
                ⌘/Ctrl+Alt+I。保持看着目标，结果会语音回答。
              </p>
              <button onClick={() => invoke('hide')}>
                隐藏工作台，观察其他应用
              </button>{' '}
              <button
                disabled={
                  !inspection.enabled ||
                  countdown ||
                  inspection.phase === 'capturing' ||
                  inspection.phase === 'thinking'
                }
                onClick={async () => {
                  const id = session.current;
                  setCountdown(true);
                  setNote(
                    '工作台隐藏后，请在3秒内看向其他应用的目标。结果保存在此面板，点击 Dock 图标返回查看。',
                  );
                  try {
                    await invoke('hide');
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    if (id !== session.current || state.current !== 'tracking')
                      return;
                    setInspection(await invoke('inspect'));
                  } catch (e) {
                    setNote(String(e));
                  } finally {
                    setCountdown(false);
                  }
                }}
              >
                3秒后识别（隐藏工作台）
              </button>
            </>
          )}
          <p role="status">
            {inspection.phase === 'capturing'
              ? '正在截取注视区域…'
              : inspection.phase === 'thinking'
                ? '截图已获取，视觉模型正在识别…'
                : inspection.phase === 'done'
                  ? '识别完成'
                  : inspection.phase === 'error'
                    ? inspection.error
                    : ''}
          </p>
          {inspection.preview && (
            <figure style={{ margin: '8px 0' }}>
              <img
                src={inspection.preview}
                alt="本次实际发送给视觉模型的注视区域截图"
                style={{
                  width: '100%',
                  maxHeight: 180,
                  objectFit: 'contain',
                  background: '#eee',
                }}
              />
              <figcaption>
                本次发送的真实区域截图（估计位置） ·{' '}
                {inspection.capturedAt
                  ? new Date(inspection.capturedAt).toLocaleTimeString()
                  : ''}
              </figcaption>
            </figure>
          )}
          {inspection.answer && (
            <p style={{ maxHeight: 160, overflowY: 'auto' }}>
              AI：{inspection.answer}
            </p>
          )}
          {report && (
            <p>
              最近验证：平均 {report.mean.toFixed(0)}px，中位{' '}
              {report.median.toFixed(0)}px，P90 {report.p90.toFixed(0)}px（
              {report.passed ? '达到实验阈值' : '未达实验阈值'}）
            </p>
          )}
        </div>
      )}
      {(stage === 'loading' || isTarget || stage === 'report') &&
        createPortal(
          <div
            className="non-draggable-area"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 2147483646,
              background: 'white',
              color: '#123',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 18,
                left: '20%',
                right: '20%',
                textAlign: 'center',
                fontSize: 17,
              }}
            >
              <h2>
                {stage === 'loading'
                  ? '正在准备'
                  : stage === 'training'
                    ? '自动九点校准'
                    : stage === 'correction'
                      ? '五点偏移补偿校准'
                      : stage === 'validation'
                        ? '独立五点精度验证'
                        : '校准完成'}
              </h2>
              <p>
                {stage === 'report'
                  ? '可以开始体验AI看屏；精度未达标也能进入演示。'
                  : note}
              </p>
              {isTarget && (
                <>
                  <p>
                    盯住
                    {stage === 'training'
                      ? '红'
                      : stage === 'correction'
                        ? '橙'
                        : '蓝'}
                    色圆点，无需点击；切换后先等待0.9秒，稳定时自动收集20帧。
                  </p>
                  <p>
                    第 {index + 1}/{stage === 'training' ? 9 : 5} 点 · 有效样本{' '}
                    {count}/{SAMPLES_PER_TARGET}
                  </p>
                  <progress value={count} max={SAMPLES_PER_TARGET} />
                </>
              )}
              <button onClick={stop}>取消 / 关闭摄像头</button>
            </div>
            {isTarget && (
              <div
                aria-label="自动采样目标"
                style={{
                  position: 'absolute',
                  left: `${target.x * 100}%`,
                  top: `${target.y * 100}%`,
                  width: 42,
                  height: 42,
                  background:
                    stage === 'training'
                      ? '#d44'
                      : stage === 'correction'
                        ? '#d88022'
                        : '#3478df',
                  borderRadius: '50%',
                  transform: 'translate(-50%,-50%)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'white',
                  pointerEvents: 'none',
                }}
              >
                {index + 1}
              </div>
            )}
            {stage === 'report' && report && (
              <div
                style={{
                  position: 'absolute',
                  top: '25%',
                  left: '25%',
                  right: '25%',
                  lineHeight: 1.8,
                  bottom: 20,
                  overflowY: 'auto',
                }}
              >
                <h3>先体验：让AI识别你在看的区域</h3>
                <p>
                  每次提问发送一张注视区域截图，位置可能有偏差。无需反复校准到达标。
                </p>
                <button
                  style={{
                    background: '#205f51',
                    color: 'white',
                    borderRadius: 10,
                    padding: '12px 18px',
                    fontSize: 18,
                  }}
                  onClick={() => track(true)}
                >
                  开始体验AI看屏{report.passed ? '' : '（低精度演示）'}
                </button>{' '}
                <button onClick={() => track(false)}>仅显示光标</button>
                <p>
                  进入后隐藏工作台，看向其他应用，按
                  ⌘/Ctrl+Alt+I；语音开启后也可以说“我在看什么”。
                </p>
                <details>
                  <summary>
                    查看精度报告（平均误差 {report.mean.toFixed(0)}px）
                  </summary>
                  <h3>
                    {report.passed
                      ? '达到实验阈值'
                      : '定位误差较大，建议重新校准'}
                  </h3>
                  <p>
                    独立的5个验证位置，共100个预测样本。单位为屏幕逻辑像素；以下主指标使用补偿后、时间滤波前的坐标。
                  </p>
                  <p>
                    原始预测：平均 {report.baseline.mean.toFixed(0)}px · P90{' '}
                    {report.baseline.p90.toFixed(0)}px。
                    {report.correction
                      ? '已使用独立五点拟合的偏移补偿。'
                      : '补偿拟合不可靠，未启用补偿。'}
                  </p>
                  <p>
                    补偿后平均误差 <b>{report.mean.toFixed(0)}px</b> · 中位误差{' '}
                    <b>{report.median.toFixed(0)}px</b> · P90{' '}
                    <b>{report.p90.toFixed(0)}px</b>
                  </p>
                  <p>
                    实验通过条件：平均 ≤ 屏幕对角线6%（
                    {(report.diagonal * 0.06).toFixed(0)}px），P90 ≤ 10%（
                    {(report.diagonal * 0.1).toFixed(0)}
                    px）。这是可调整的产品实验阈值，不是精度保证。
                  </p>
                  <p>
                    采样中心偏差 RMS：{report.biasRms.toFixed(0)}px；注视内离散
                    RMS：{report.jitterRms.toFixed(0)}px。
                    {report.biasRms > report.jitterRms * 1.5
                      ? ' 当前以预测中心偏离目标为主，单靠平滑不能纠正。'
                      : report.jitterRms > report.biasRms * 1.5
                        ? ' 当前以采样离散为主，需要检查采集质量与稳定性。'
                        : ' 偏移和离散都不可忽略。'}
                  </p>
                  <p>
                    平均方向：{report.meanDx >= 0 ? '向右' : '向左'}{' '}
                    {Math.abs(report.meanDx).toFixed(0)}px，
                    {report.meanDy >= 0 ? '向下' : '向上'}{' '}
                    {Math.abs(report.meanDy).toFixed(0)}
                    px（不同位置偏差可能互相抵消）。
                  </p>
                  <svg
                    aria-label="验证目标与预测中心偏移图"
                    viewBox={`0 0 ${report.width} ${report.height}`}
                    style={{
                      width: '100%',
                      maxHeight: 220,
                      border: '1px solid #ddd',
                      background: '#fafafa',
                    }}
                  >
                    {report.perPoint.map((p, i) => (
                      <g key={i}>
                        <line
                          x1={p.target.x * report.width}
                          y1={p.target.y * report.height}
                          x2={p.center.x}
                          y2={p.center.y}
                          stroke="#555"
                          strokeWidth={3}
                        />
                        <circle
                          cx={p.target.x * report.width}
                          cy={p.target.y * report.height}
                          r={10}
                          fill="#3478df"
                        />
                        <circle
                          cx={p.center.x}
                          cy={p.center.y}
                          r={Math.max(5, p.jitter)}
                          fill="#e7555520"
                          stroke="#d44"
                          strokeWidth={2}
                        />
                        <circle
                          cx={p.center.x}
                          cy={p.center.y}
                          r={6}
                          fill="#d44"
                        />
                        <text
                          x={p.target.x * report.width + 14}
                          y={p.target.y * report.height}
                          fontSize={26}
                        >
                          {i + 1}
                        </text>
                      </g>
                    ))}
                  </svg>
                  <p>
                    蓝点＝目标；红点＝预测中心；红圈＝该点样本的 RMS
                    离散半径，非置信区间。超出屏幕的预测可能不显示在图内，但仍计入误差。
                  </p>
                  <ul>
                    {report.perPoint.map((v, i) => (
                      <li key={i}>
                        验证点 {i + 1}：平均 {v.mean.toFixed(0)}px · 偏移 (
                        {v.dx.toFixed(0)}, {v.dy.toFixed(0)})px · 离散{' '}
                        {v.jitter.toFixed(0)}px
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(report, null, 2)], {
                          type: 'application/json',
                        }),
                      );
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'cyrvis-gaze-validation.json';
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    导出数值诊断（无摄像头图像）
                  </button>{' '}
                  <button onClick={() => start()}>重新自动校准</button>
                </details>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
