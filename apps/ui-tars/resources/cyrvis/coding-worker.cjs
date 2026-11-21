/*
 * Standalone Qwen Code SDK worker.
 *
 * The SDK runs its bundled CLI with process.execPath. In Electron main,
 * process.execPath is electron.exe, so spawning the SDK there launches a
 * second Electron instance instead of Node. This worker always runs under a
 * real Node executable and speaks newline-delimited JSON to the parent.
 */
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('@qwen-code/sdk');

const SAFE_COMMANDS = [
  /^node(?:\.exe)?\s+[\w./\\-]+\.(?:js|mjs|cjs)(?:\s+.*)?$/i,
  /^npm(?:\.cmd)?\s+test(?:\s+.*)?$/i,
  /^npm(?:\.cmd)?\s+run\s+test(?:\s+.*)?$/i,
  /^npx(?:\.cmd)?\s+vitest(?:\s+.*)?$/i,
  /^pytest(?:\s+.*)?$/i,
  /^(?:python(?:3)?(?:\.exe)?|py(?:\.exe)?)\s+(?:(?:-u|-2|-3)\s+)*(?:"[^"]+\.py"|'[^']+\.py'|[A-Za-z]:[\\/][^\s]+\.py|[^\s]+\.py)(?:\s+.*)?$/i,
  /^python(?:3)?(?:\.exe)?\s+-m\s+(?:pytest|py_compile)(?:\s+.*)?$/i,
  // Environment probes are read-only and were the main source of retry loops:
  // the coding model checked python/matplotlib/turtle, got "Command is not
  // allowed", then repeated the same check instead of writing code.
  /^(?:python(?:3)?(?:\.exe)?|py(?:\.exe)?)\s+(?:--version|-V)$/i,
  /^(?:python(?:3)?(?:\.exe)?|py(?:\.exe)?)\s+-c\s+[\s\S]+$/i,
  /^git(?:\.exe)?\s+(?:status|diff)(?:\s+.*)?$/i,
  /^git(?:\.exe)?\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+(?:status|diff)(?:\s+.*)?$/i,
  /^(?:dir|ls)(?:\s+.*)?$/i,
  /^pwd$/i,
  /^echo(?:\s+[\s\S]*)?$/i,
  /^(?:which|command\s+-v)\s+[\w./-]+$/i,
  /^(?:head|tail)\s+(?:-\d+|-n\s+\d+)$/i,
];

const redact = (value) =>
  String(value)
    .replace(/sk-[A-Za-z0-9._-]{8,}/g, 'sk-***')
    .replace(/(QWEN_API_KEY\s*=\s*)\S+/gi, '$1***')
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1***');

const toolInputText = (input) =>
  input && typeof input === 'object' ? input : {};

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'replace']);

const filePathOf = (input) => {
  const data = toolInputText(input);
  return String(data.file_path || data.path || '').trim();
};

const describeTool = (name, input) => {
  const data = toolInputText(input);
  const target = redact(data.file_path || data.path || data.pattern || '').slice(0, 160);
  if (name === 'run_shell_command') {
    return `正在运行命令：${redact(data.command || '').slice(0, 200)}`;
  }
  if (name === 'write_file') {
    return `正在写入文件：${target}`;
  }
  if (name === 'read_file') {
    return `正在读取文件：${target}`;
  }
  if (name === 'glob') {
    return `正在查找文件：${target}`;
  }
  if (name === 'grep') {
    return `正在搜索内容：${target}`;
  }
  return `正在执行 ${name}`;
};

const TOOL_LABELS = {
  run_shell_command: '命令',
  write_file: '写入文件',
  read_file: '读取文件',
  glob: '查找文件',
  grep: '搜索内容',
  edit_file: '修改文件',
  replace: '修改文件',
};

const toolResultText = (part) => {
  const content = part.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && block.type === 'text' ? String(block.text || '') : '',
      )
      .join('\n');
  }
  return '';
};

const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

let finished = false;
const finish = (value) => {
  if (finished) {
    return;
  }
  finished = true;
  send(value);
  // The SDK may keep its bundled CLI alive after the result. Exit explicitly
  // so the parent always sees a close event instead of waiting for the outer
  // five-minute timeout.
  setTimeout(() => process.exit(value.ok ? 0 : 1), 100);
};

const watchdog = setTimeout(() => {
  finish({ type: 'result', ok: false, error: 'coding worker timed out' });
}, Number(process.env.CYRV_CODING_TIMEOUT_MS || 120_000));
watchdog.unref?.();

/**
 * Canonicalize a path even when its leaf does not exist yet. macOS maps /tmp
 * to /private/tmp, and the Qwen SDK hands us the canonical spelling; comparing
 * raw strings would wrongly reject writes inside the workspace.
 */
const canonicalPath = (target) => {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
};

const isInside = (root, candidate) => {
  const resolvedRoot = canonicalPath(root);
  const resolved = canonicalPath(path.resolve(root, candidate));
  return (
    resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)
  );
};

/**
 * Split a command into simple pipeline/sequence stages while respecting
 * quotes. Returns null for constructs that would bypass the allowlist
 * (background execution, command substitution, file redirection).
 */
const splitShellCommand = (command) => {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '`' || (char === '$' && command[i + 1] === '(')) {
      return null;
    }
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\' && quote !== "'") {
        current += char;
        escaped = true;
        continue;
      }
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\n' || char === '\r') return null;
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (char === '|' && command[i + 1] === '|') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    if (char === '&') return null;
    if (char === '>' || char === '<') {
      // Allow only the stderr merge "2>&1"; all other redirections are denied.
      if (
        char === '>' &&
        command[i - 1] === '2' &&
        command[i + 1] === '&' &&
        command[i + 2] === '1'
      ) {
        if (!current.endsWith('2')) return null;
        current = current.slice(0, -1);
        i += 2;
        continue;
      }
      return null;
    }
    current += char;
  }
  if (quote || escaped) return null;
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
};

const isSafeShellCommand = (command, workspace, outputDir) => {
  const segments = splitShellCommand(command);
  if (!segments || !segments.length) return false;
  let start = 0;
  if (/^cd(?:\s|$)/i.test(segments[0])) {
    const match = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i.exec(segments[0]);
    if (!match) return false;
    const directory = (match[1] || match[2] || match[3] || '').trim();
    if (!directory || directory.startsWith('~') || directory.includes('$')) {
      return false;
    }
    const allowed =
      isInside(workspace, directory) ||
      (outputDir && isInside(outputDir, directory));
    if (!allowed) return false;
    start = 1;
  }
  if (start >= segments.length) return false;
  return segments.slice(start).every((segment) => {
    const gitC = /^git(?:\.exe)?\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+/i.exec(
      segment,
    );
    if (gitC) {
      const directory = (gitC[1] || gitC[2] || gitC[3] || '').trim();
      if (
        !directory ||
        directory.startsWith('~') ||
        directory.includes('$')
      ) {
        return false;
      }
      const allowed =
        isInside(workspace, directory) ||
        (outputDir && isInside(outputDir, directory));
      if (!allowed) return false;
    }
    return SAFE_COMMANDS.some((pattern) => pattern.test(segment));
  });
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  void run(JSON.parse(input.trim() || '{}'));
});

async function run(config) {
  const workspace = path.resolve(config.workspace || process.cwd());
  const outputDir = config.outputDir
    ? path.resolve(config.outputDir)
    : '';
  const model = config.model || 'deepseek-flash';
  const apiKey = process.env.QWEN_API_KEY || '';
  // Deliverables written outside the workspace may be read back so the model
  // can verify its own output. Existing desktop files are not browsable.
  const writtenOutputPaths = new Set();
  if (!apiKey) {
    finish({ type: 'result', ok: false, error: 'QWEN_API_KEY is not set' });
    return;
  }

  const canUseTool = async (toolName, toolInput) => {
    const filePath = String(toolInput.file_path || toolInput.path || '');
    if (filePath) {
      // Reads stay confined to the workspace. Deliverables may be written to
      // an explicit output directory (macOS Desktop by default) when the user
      // asks for a file there; without this, "create heart.py on the desktop"
      // could never succeed. A file written there can then be read back for
      // verification, but unrelated desktop files stay private.
      const canonicalFile = canonicalPath(filePath);
      const inWorkspace = isInside(workspace, filePath);
      const inOutput = outputDir !== '' && isInside(outputDir, filePath);
      let allowed = inWorkspace;
      if (!allowed && inOutput) {
        if (WRITE_TOOLS.has(toolName)) {
          writtenOutputPaths.add(canonicalFile);
          allowed = true;
        } else {
          allowed = writtenOutputPaths.has(canonicalFile);
        }
      }
      if (!allowed) {
        return { behavior: 'deny', message: 'Path is outside the workspace.' };
      }
    }
    if (toolName === 'run_shell_command') {
      const command = String(toolInput.command || '').trim();
      const directory = String(toolInput.directory || workspace);
      const directoryAllowed =
        isInside(workspace, directory) ||
        (outputDir !== '' && isInside(outputDir, directory));
      if (!directoryAllowed) {
        return { behavior: 'deny', message: 'Command directory is outside the workspace.' };
      }
      if (!isSafeShellCommand(command, workspace, outputDir)) {
        send({ type: 'permission', tool: toolName, command, allowed: false });
        return {
          behavior: 'deny',
          message: `Command is not allowed: ${command}. Write the code to a file in the workspace and run it with python3/node, or use only ls/pwd/which/head/tail/echo and the python -c form.`,
        };
      }
      send({ type: 'permission', tool: toolName, command, allowed: true });
    }
    return { behavior: 'allow', updatedInput: toolInput };
  };

  try {
    const result = query({
      prompt: config.instruction,
      options: {
        cwd: workspace,
        model,
        permissionMode: 'default',
        env: { QWEN_API_KEY: apiKey },
        canUseTool,
        excludeTools: [
          'Read(.env)',
          'Read(**/.env)',
          'Read(**/.env.*)',
          'Read(**/.ssh/**)',
          'Read(**/id_rsa)',
          'Read(**/*.pem)',
          'Read(**/credentials*)',
        ],
      },
    });

    const toolCalls = new Map();
    for await (const message of result) {
      if (message.type === 'assistant') {
        for (const part of message.message?.content || []) {
          if (part.type === 'tool_use' && part.name) {
            const tool = {
              name: part.name,
              filePath: filePathOf(part.input),
              changed: WRITE_TOOLS.has(part.name),
            };
            toolCalls.set(part.id, tool);
            send({
              type: 'status',
              message: describeTool(part.name, part.input),
              tool: part.name,
              filePath: tool.filePath,
              changed: tool.changed,
            });
          }
        }
      } else if (message.type === 'user') {
        for (const part of message.message?.content || []) {
          if (part.type !== 'tool_result') {
            continue;
          }
          const tool = toolCalls.get(part.tool_use_id) || {
            name: '工具',
            filePath: '',
            changed: false,
          };
          const label = TOOL_LABELS[tool.name] || tool.name;
          const output = redact(toolResultText(part)).trim().slice(0, 500);
          send({
            type: 'status',
            message: output
              ? `${label}${part.is_error ? '失败' : '完成'}：${output}`
              : `${label}${part.is_error ? '失败' : '完成'}`,
            tool: tool.name,
            filePath: tool.filePath,
            changed: tool.changed,
            ok: part.is_error !== true,
            output,
          });
        }
      } else if (message.type === 'result') {
        finish({
          type: 'result',
          ok: message.is_error !== true,
          result: typeof message.result === 'string' ? message.result : '',
          error: message.is_error
            ? message.error?.message || 'coding task failed'
            : null,
        });
        return;
      }
    }
    finish({ type: 'result', ok: true, result: '', error: null });
  } catch (error) {
    finish({
      type: 'result',
      ok: false,
      result: '',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
