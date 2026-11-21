import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopHost } from './types';
import { createFastToolContext } from './matrix';
import { OFFICE_TOOLS } from './office-tools';

describe('office.create_presentation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-office-'));
    vi.stubEnv('CYRVIS_QWEN_DOC_API_KEY', '');
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('QWEN_API_KEY', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('falls back to a configured remote document API when PowerPoint is unavailable', async () => {
    const host = {
      createPresentation: vi.fn(async () => {
        throw new Error('PowerPoint not installed');
      }),
      openPath: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const { context } = createFastToolContext(host, root);
    const definition = OFFICE_TOOLS[0];
    const target = path.join(root, 'deck.pptx');
    const prepared = await definition.prepare(
      {
        path: target,
        title: 'Quarterly review',
        subtitle: 'CYRVIS',
      },
      context,
    );
    vi.stubEnv('CYRVIS_DOCUMENT_API_URL', 'http://127.0.0.1:8080/pptx');
    vi.stubEnv('CYRVIS_DOCUMENT_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '8' }),
      arrayBuffer: async () =>
        new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await definition.execute(prepared, context);
    expect(result).toMatchObject({
      ok: true,
      data: { provider: 'remote-document-api' },
    });
    await expect(fs.readFile(target)).resolves.toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: '127.0.0.1' }),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('generates a PPT through qwen-doc-turbo streaming and downloads the result', async () => {
    const host = {
      createPresentation: vi.fn(async () => {
        throw new Error('PowerPoint should not be used');
      }),
      openPath: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const { context } = createFastToolContext(host, root);
    const reportProgress = vi.fn();
    context.reportProgress = reportProgress;
    const definition = OFFICE_TOOLS[0];
    const target = path.join(root, 'qwen.pptx');
    const prepared = await definition.prepare(
      {
        path: target,
        title: '年度产品规划',
        subtitle: '2027 路线图',
        content: '产品目标与关键里程碑。',
        mode: 'general',
        templateId: 'thesis_01',
        pageCount: 12,
        audience: '管理层',
      },
      context,
    );
    vi.stubEnv('CYRVIS_QWEN_DOC_API_KEY', 'qwen-doc-key');
    vi.stubEnv('CYRVIS_QWEN_DOC_WORKSPACE_ID', 'workspace-test');
    const presentationBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
    ]);
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        );
        if (url.pathname.endsWith('/chat/completions')) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"reasoning_content":"outline"}}]}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode(
                  // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
                  'data: {"choices":[{"delta":{"content":"https://files.example.com/deck.pptx?token=abc"}}]}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(presentationBytes, {
          status: 200,
          headers: {
            'content-type':
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'content-length': String(presentationBytes.length),
          },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await definition.execute(prepared, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        provider: 'qwen-doc-turbo',
        mode: 'general',
        templateId: 'thesis_01',
        downloadHost: 'files.example.com',
      },
    });
    expect(host.createPresentation).not.toHaveBeenCalled();
    // macOS /var is a symlink to /private/var; compare the canonical path.
    expect(host.openPath).toHaveBeenCalledWith(await fs.realpath(target));
    expect(reportProgress).toHaveBeenCalledWith('正在整理演示内容。', 8);
    expect(reportProgress).toHaveBeenCalledWith('正在规划演示结构。', 28);
    expect(reportProgress).toHaveBeenCalledWith('正在下载并校验演示文稿。', 82);
    await expect(fs.readFile(target)).resolves.toEqual(presentationBytes);

    const request = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/chat/completions'),
    );
    expect(String(request?.[0])).toBe(
      'https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body).toMatchObject({
      model: 'qwen-doc-turbo',
      stream: true,
      skill: [
        {
          type: 'ppt',
          mode: 'general',
          template_id: 'thesis_01',
        },
      ],
    });
    expect(body.messages[1].content).toContain('产品目标与关键里程碑');
  });

  it('falls back to local PowerPoint when qwen-doc generation fails', async () => {
    const host = {
      createPresentation: vi.fn(async (input: { path: string }) => {
        await fs.writeFile(
          input.path,
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
        );
      }),
      openPath: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const { context } = createFastToolContext(host, root);
    const definition = OFFICE_TOOLS[0];
    const target = path.join(root, 'fallback.pptx');
    const prepared = await definition.prepare(
      {
        path: target,
        title: 'Fallback deck',
      },
      context,
    );
    vi.stubEnv('CYRVIS_QWEN_DOC_API_KEY', 'qwen-doc-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"message":"quota exceeded"}', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
      ),
    );

    const result = await definition.execute(prepared, context);
    expect(result).toMatchObject({
      ok: true,
      data: { provider: 'powerpoint' },
    });
    expect(host.createPresentation).toHaveBeenCalledOnce();
  });

  it('does not degrade a complex cloud deck into a local one-slide file', async () => {
    const host = {
      createPresentation: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const { context } = createFastToolContext(host, root);
    const definition = OFFICE_TOOLS[0];
    const prepared = await definition.prepare(
      {
        path: path.join(root, 'complex.pptx'),
        title: '年度战略汇报',
        content:
          '制作一份详细的年度战略汇报，包含市场分析、竞品、路线图、风险和总结。',
        pageCount: 16,
        audience: '管理层',
      },
      context,
    );
    vi.stubEnv('CYRVIS_QWEN_DOC_API_KEY', 'qwen-doc-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"message":"quota exceeded"}', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
      ),
    );

    const result = await definition.execute(prepared, context);

    expect(result.ok).toBe(false);
    expect(result.speech).toContain('PPT 制作没有完成');
    expect(result.speech).not.toContain('qwen-doc-turbo');
    expect(result.speech).not.toContain('API');
    expect(host.createPresentation).not.toHaveBeenCalled();
    expect(typeof definition.requiresConfirmation).toBe('function');
  });

  it('defaults an unspecified presentation path to the desktop', async () => {
    const host = {
      openPath: vi.fn(async () => undefined),
    } as unknown as DesktopHost;
    const { context } = createFastToolContext(host, root);
    const definition = OFFICE_TOOLS[0];

    const prepared = await definition.prepare(
      { title: 'Desktop deck' },
      context,
    );

    expect(path.dirname(String(prepared.path))).toBe(
      path.join(os.homedir(), 'Desktop'),
    );
    expect(path.basename(String(prepared.path))).toMatch(
      /^CYRVIS-Desktop deck-\d{14}\.pptx$/,
    );
  });
});
