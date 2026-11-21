import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

import { logger } from '@main/logger';

const execFileAsync = promisify(execFile);

export type CodingTaskStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CodingProgressEvent {
  tool: string;
  message: string;
  ok?: boolean;
  output?: string;
  filePath?: string;
  changed?: boolean;
}

export interface CodingTaskSnapshot {
  taskId: string | null;
  status: CodingTaskStatus;
  instruction: string | null;
  workspace: string;
  startedAt: number | null;
  endedAt: number | null;
  lastMessage: string;
  lastEvent: CodingProgressEvent | null;
  result: string;
  diff: string;
  changedFiles: string[];
  error: string | null;
}

export interface CodingAgentOptions {
  workspace: string;
  /** Optional directory where the user asked for deliverable files. */
  outputDir?: string;
  model?: string;
  workerPath?: string;
  maxDurationMs?: number;
}

export interface CodingAgentController {
  getStatus(): CodingTaskSnapshot;
  getWorkspace(): string;
  isBusy(): boolean;
  start(instruction: string): Promise<CodingTaskSnapshot>;
  cancel(): Promise<CodingTaskSnapshot>;
}

const redactSecrets = (value: string): string =>
  value
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
    .replace(/(QWEN_API_KEY\s*=\s*)\S+/gi, '$1***')
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1***');

/**
 * Qwen Code manages long-running commands with an internal background-shell
 * status file. Its own polling command (sleep + cat under ~/.qwen/tmp) is
 * rejected by our shell policy and arrives as "命令失败：Blocked: sleep 3 …".
 * That is not the user's task failing, so keep it out of the task panel and
 * the voice progress stream.
 */
const isInternalCodingMessage = (message: string, filePath?: string): boolean =>
  /(?:background[- ]shells?|shell-bg_|\.qwen\/tmp|Blocked:\s*sleep\b)/i.test(
    `${message} ${filePath || ''}`,
  );

/**
 * Coding-specific defaults that the spoken instruction does not carry.
 * Turtle's `exitonclick()` closes the window on the first click, which made
 * every heart-window test look like a crash. Keep the window open until the
 * user closes it with the window button.
 */
const withCodingConventions = (instruction: string): string =>
  [
    instruction,
    '',
    '[CYRVIS 工程约定]',
    '- macOS 图形脚本（turtle/pygame）使用 turtle.done() 或 screen.mainloop() 保持窗口；不要使用 screen.exitonclick()，让用户点窗口关闭按钮退出。',
    '- 默认让绘制过程可见：turtle 用 pen.speed(2) 和 screen.tracer(1, 0.01)，不要用 pen.speed(0) 或 screen.tracer(0) 瞬间画完；只有用户明确要求秒出时才瞬间完成。',
    '- 用户说的英文文件名要按意图拼写：heart 不要写成 hard。',
    '- 图形脚本写到工作区/输出目录即可，由应用在任务完成后自动运行；不要用后台 shell 启动 GUI。',
  ].join('\n');

const WORKER_CANDIDATES = (configured?: string): string[] => [
  ...(configured ? [configured] : []),
  ...(process.env.CYRVIS_CODING_WORKER
    ? [process.env.CYRVIS_CODING_WORKER]
    : []),
  path.resolve(process.cwd(), 'resources', 'cyrvis', 'coding-worker.cjs'),
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'resources',
    'cyrvis',
    'coding-worker.cjs',
  ),
  ...(process.resourcesPath
    ? [path.join(process.resourcesPath, 'cyrvis', 'coding-worker.cjs')]
    : []),
];

export class CodingAgentService {
  private current: CodingTaskSnapshot = {
    taskId: null,
    status: 'idle',
    instruction: null,
    workspace: '',
    startedAt: null,
    endedAt: null,
    lastMessage: '',
    lastEvent: null,
    result: '',
    diff: '',
    changedFiles: [],
    error: null,
  };
  private child: ChildProcessWithoutNullStreams | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private statusListener: ((snapshot: CodingTaskSnapshot) => void) | null =
    null;

  constructor(private readonly options: CodingAgentOptions) {}

  getStatus(): CodingTaskSnapshot {
    return {
      ...this.current,
      lastEvent: this.current.lastEvent ? { ...this.current.lastEvent } : null,
      changedFiles: [...this.current.changedFiles],
    };
  }

  getWorkspace(): string {
    return path.resolve(this.options.workspace);
  }

  setStatusListener(
    listener: ((snapshot: CodingTaskSnapshot) => void) | null,
  ): void {
    this.statusListener = listener;
  }

  isBusy(): boolean {
    return this.current.status === 'running';
  }

  async start(instruction: string): Promise<CodingTaskSnapshot> {
    const trimmed = instruction.trim();
    if (!trimmed) {
      throw new Error('coding instruction is empty');
    }
    if (this.isBusy()) {
      throw new Error('a coding task is already running');
    }

    const workspace = path.resolve(this.options.workspace);
    await this.ensureWorkspace(workspace);

    const apiKey = process.env.QWEN_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('QWEN_API_KEY is not set');
    }

    const worker = await this.findWorker();
    const taskId = randomUUID();
    this.current = {
      taskId,
      status: 'running',
      instruction: trimmed,
      workspace,
      startedAt: Date.now(),
      endedAt: null,
      lastMessage: '任务已启动',
      lastEvent: null,
      result: '',
      diff: '',
      changedFiles: [],
      error: null,
    };

    const child = spawn(
      process.env.CYRV_NODE_EXECUTABLE?.trim() || 'node',
      [worker],
      {
        cwd: workspace,
        env: { ...process.env, QWEN_API_KEY: apiKey },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.child = child;

    const maxDurationMs = this.options.maxDurationMs ?? 5 * 60_000;
    this.timeout = setTimeout(() => {
      this.killWorker();
    }, maxDurationMs);

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      this.handleWorkerLine(line, taskId);
    });

    child.on('error', (error) => {
      logger.warn('[cyrvis coding] worker error', error);
      if (this.current.taskId === taskId) {
        this.finish('failed', error.message);
      }
    });

    child.on('close', (code) => {
      lines.close();
      void this.handleWorkerClose(taskId, code, stderr);
    });

    child.stdin.end(
      `${JSON.stringify({
        instruction: withCodingConventions(trimmed),
        workspace,
        outputDir: this.options.outputDir || '',
        model: this.options.model || 'deepseek-flash',
      })}\n`,
    );

    return this.getStatus();
  }

  async cancel(): Promise<CodingTaskSnapshot> {
    if (this.current.status !== 'running') {
      return this.getStatus();
    }
    this.current.status = 'cancelled';
    this.current.endedAt = Date.now();
    this.current.error = null;
    this.current.lastMessage = '编码任务已取消';
    this.current.lastEvent = null;
    this.clearTimeout();
    this.killWorker();
    this.emitStatus();
    return this.getStatus();
  }

  private handleWorkerLine(line: string, taskId: string): void {
    if (this.current.taskId !== taskId || !line.trim()) {
      return;
    }
    let event: {
      type?: string;
      message?: string;
      ok?: boolean;
      result?: string;
      error?: string | null;
      tool?: string;
      output?: string;
      filePath?: string;
      changed?: boolean;
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      logger.debug('[cyrvis coding] non-JSON worker output', { line });
      return;
    }

    if (event.type === 'status' && event.message) {
      if (this.current.status !== 'running') {
        return;
      }
      if (isInternalCodingMessage(event.message, event.filePath)) {
        logger.info('[cyrvis coding] internal progress', {
          message: event.message.slice(0, 300),
          filePath: event.filePath,
        });
        return;
      }
      this.current.lastMessage = event.message;
      this.current.lastEvent = {
        tool: event.tool || '',
        message: event.message,
        ok: event.ok,
        output: event.output,
        filePath: event.filePath,
        changed: event.changed,
      };
      if (event.changed && event.filePath && event.ok === true) {
        const resolved = path.resolve(this.current.workspace, event.filePath);
        const outputDir = this.options.outputDir
          ? path.resolve(this.options.outputDir)
          : '';
        const inside = (root: string): boolean => {
          const relative = path.relative(root, resolved);
          return (
            relative === '' ||
            (!relative.startsWith('..') && !path.isAbsolute(relative))
          );
        };
        if (
          (inside(path.resolve(this.current.workspace)) ||
            (outputDir !== '' && inside(outputDir))) &&
          !this.current.changedFiles.some(
            (file) => path.resolve(file) === resolved,
          )
        ) {
          this.current.changedFiles.push(resolved);
        }
      }
      logger.info('[cyrvis coding] progress', {
        message: event.message.slice(0, 300),
        changedFiles: this.current.changedFiles,
      });
      this.emitStatus();
      return;
    }
    if (event.type === 'permission') {
      logger.info('[cyrvis coding] worker permission', event);
      return;
    }
    if (event.type === 'result') {
      const result = redactSecrets(event.result || '');
      const error = event.error ? redactSecrets(event.error) : null;
      logger.info('[cyrvis coding] worker result', {
        ok: event.ok !== false,
        result: result.slice(0, 500),
        error,
      });
      this.current.result = result;
      this.finish(
        event.ok === false ? 'failed' : 'done',
        event.ok === false ? error || 'coding task failed' : null,
      );
    }
  }

  private async handleWorkerClose(
    taskId: string,
    code: number | null,
    stderr: string,
  ): Promise<void> {
    this.child = null;
    this.clearTimeout();
    if (this.current.taskId !== taskId) {
      return;
    }
    const cleanStderr = redactSecrets(stderr.trim().slice(-500));
    logger.info('[cyrvis coding] worker close', {
      code,
      status: this.current.status,
      stderr: cleanStderr,
    });
    if (this.current.status === 'running') {
      this.finish(
        'failed',
        `coding worker exited with code ${code ?? 'unknown'}${
          cleanStderr ? `: ${cleanStderr}` : ''
        }`,
      );
    }
    if (this.current.status !== 'cancelled') {
      this.current.diff = await this.readDiff(this.current.workspace);
    }
    this.emitStatus();
  }

  private finish(
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ): void {
    if (this.current.status === 'cancelled') {
      return;
    }
    this.current.status = status;
    this.current.endedAt = Date.now();
    this.current.error = error;
    this.current.lastMessage =
      status === 'done'
        ? '编码任务完成'
        : status === 'failed'
          ? '编码任务失败'
          : '编码任务已取消';
    this.current.lastEvent = null;
    this.clearTimeout();
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private killWorker(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) {
      return;
    }
    if (process.platform === 'win32' && child.pid) {
      // Stop is a safety control. Kill the whole tree synchronously so a new
      // coding task cannot race the old CLI before it exits.
      try {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 3_000,
        });
      } catch (error) {
        logger.warn('[cyrvis coding] taskkill failed', error);
        child.kill();
      }
    } else {
      child.kill('SIGTERM');
    }
  }

  private emitStatus(): void {
    logger.info('[cyrvis coding] emit status', {
      status: this.current.status,
      hasListener: Boolean(this.statusListener),
      diff: this.current.diff.slice(0, 200),
    });
    this.statusListener?.(this.getStatus());
  }

  private async findWorker(): Promise<string> {
    for (const candidate of WORKER_CANDIDATES(this.options.workerPath)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next candidate
      }
    }
    throw new Error('coding worker not found');
  }

  private async ensureWorkspace(workspace: string): Promise<void> {
    await fs.mkdir(workspace, { recursive: true });
    const settingsPath = path.join(workspace, '.qwen', 'settings.json');
    try {
      await fs.access(settingsPath);
      return;
    } catch {
      // Create a project-local provider config only when the workspace has
      // none. This keeps the API key in the environment, never in the file.
    }

    const baseUrl = process.env.CONVERSATION_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error('CONVERSATION_BASE_URL is not set for coding agent');
    }

    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          modelProviders: {
            openai: [
              {
                id: this.options.model || 'deepseek-flash',
                name: this.options.model || 'deepseek-flash',
                envKey: 'QWEN_API_KEY',
                baseUrl,
                wireApi: 'chat-completions',
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  private async readDiff(workspace: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', workspace, 'diff', '--stat'],
        { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim().slice(0, 20_000);
    } catch {
      return '';
    }
  }
}
