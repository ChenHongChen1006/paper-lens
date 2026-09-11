// Regression tests for the "analysis silently fails after ~40s, no error
// shown, module reverts to 尚未分析" bug.
//
// Root cause: when Claude's response for a tool-use call is cut off by
// hitting max_tokens mid-generation (stop_reason: 'max_tokens'), the API
// still returns a structurally-valid but incomplete `input` object (which
// can be `{}` — no `items` key at all). The old code only checked
// `typeof toolUse.input === 'object'`, which an empty object satisfies,
// so it was accepted as a legitimate — if empty — successful analysis:
// `saveAnalysis(paperId, moduleId, { status: 'done', items: [] })`. Since
// `items.length === 0`, the module then rendered as "尚未分析" (see
// AnalysisModule.jsx: hasResult checks items.length > 0) with no error
// anywhere, because no exception was ever thrown — analyzeOne() genuinely
// took the success path.
//
// These tests mock the @anthropic-ai/sdk client entirely (no real network
// calls) and exercise runModuleAnalysis() end-to-end for each failure mode
// listed in the request.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

const { runModuleAnalysis, translateApiError } = await import('../lib/api.js');

const segments = [
  { id: 'p1-s1', page: 1, text: 'This paper studies deep learning methods for photoplethysmography.' },
  { id: 'p2-s1', page: 2, text: 'We used a scoping review methodology following PRISMA guidelines.' },
];

const baseArgs = { apiKey: 'sk-ant-test-key', model: 'claude-sonnet-5', segments, moduleId: 'methodology' };

function toolUseResponse({ items, stop_reason = 'tool_use', usage = { input_tokens: 500, output_tokens: 200 } }) {
  return {
    stop_reason,
    usage,
    content: [{ type: 'tool_use', name: 'record_analysis', input: { items } }],
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('1. normal success response', () => {
  it('resolves with the analysis items', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [{ segmentId: 'p1-s1', page: 1, quote: 'q' }] }],
      })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(result.data.items).toHaveLength(1);
    expect(result.usage.inputTokens).toBe(500);
  });
});

describe('2. API reject (e.g. auth/rate-limit error from the SDK)', () => {
  it('rejects rather than swallowing the error, and translateApiError gives a clear zh-TW message', async () => {
    const apiError = Object.assign(new Error('invalid x-api-key'), { status: 401, name: 'AuthenticationError' });
    mockCreate.mockRejectedValueOnce(apiError);
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow();
    expect(translateApiError(apiError)).toContain('API key 無效');
  });
});

describe('3. timeout', () => {
  it('translateApiError gives a distinct 逾時 message, not the generic CORS/connection message', () => {
    const timeoutError = Object.assign(new Error('Request timed out'), { name: 'APIConnectionTimeoutError' });
    const message = translateApiError(timeoutError);
    expect(message).toContain('逾時');
    expect(message).not.toContain('CORS');
  });

  it('a request that rejects with a timeout error propagates as a rejection, not a silent empty success', async () => {
    const timeoutError = Object.assign(new Error('Request timed out'), { name: 'APIConnectionTimeoutError' });
    mockCreate.mockRejectedValueOnce(timeoutError);
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Request timed out');
  });
});

describe('4. malformed tool-use — the actual root cause of the reported bug', () => {
  it('a response truncated by max_tokens (empty/incomplete tool input) throws instead of returning a fake empty success', async () => {
    // This is exactly what a long paper's methodology analysis produced:
    // stop_reason max_tokens, and an `input` with no `items` key at all.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 28000, output_tokens: 4096 },
      content: [{ type: 'tool_use', name: 'record_analysis', input: {} }],
    });

    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow(/截斷|逾時|長度上限/);
  });

  it('a truncated response with a partially-built items array also throws (does not silently save partial data as done)', async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 28000, output_tokens: 4096 },
      content: [
        {
          type: 'tool_use',
          name: 'record_analysis',
          input: { items: [{ id: 'item-1', title: 'T', claim: 'partial cla' }] },
        },
      ],
    });
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow(/截斷|長度上限/);
  });
});

describe('11. status=done + items=[] must never happen (the actual reported bug)', () => {
  it('Claude genuinely returning an empty items array — response complete, NOT truncated — is still treated as a failure', async () => {
    // stop_reason is 'end_turn', not 'max_tokens' — assertNotTruncated()
    // would NOT catch this case. Only the finalItemCount === 0 guard does.
    mockCreate.mockResolvedValueOnce(toolUseResponse({ items: [], stop_reason: 'end_turn' }));
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  });

  it('raw response has items, but every single one gets rejected by normalization (all invalid kind) — still an error, not status=done', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [
          { id: 'item-1', title: 'T1', claim: 'C1', kind: 'maybe', evidence: [] },
          { id: 'item-2', title: 'T2', claim: 'C2', kind: 'unsure', evidence: [] },
        ],
        stop_reason: 'end_turn',
      })
    );
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  });

  it.each(['overview', 'methodology', 'data', 'reproducibility', 'limitations'])(
    'applies to the %s module too — no module accepts an empty result as done',
    async (moduleId) => {
      mockCreate.mockResolvedValueOnce(toolUseResponse({ items: [], stop_reason: 'end_turn' }));
      await expect(runModuleAnalysis({ ...baseArgs, moduleId })).rejects.toThrow(
        'Claude 已回應，但沒有產生可用的分析結果。請重試。'
      );
    }
  );

  it('a genuinely successful analysis with at least one item is unaffected by this guard', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }] })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(result.data.items).toHaveLength(1);
  });
});

describe('5. malformed JSON fallback', () => {
  it('when there is no tool_use block AND the fallback plain-text response is not valid JSON, it throws a clear format error', async () => {
    // First call: no tool_use block at all (some models do this).
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 20 },
      content: [{ type: 'text', text: "Sorry, I can't use tools right now." }],
    });
    // Second call (fallback plain-JSON request): garbage text.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 20 },
      content: [{ type: 'text', text: 'not valid json at all {{{' }],
    });

    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('AI 回傳格式異常，請重新分析。');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe('6. optional field (sourceScope) missing does not crash', () => {
  it('a data-module item with no sourceScope still resolves, normalized to "unclear"', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }],
      })
    );
    const result = await runModuleAnalysis({ ...baseArgs, moduleId: 'data' });
    expect(result.data.items[0].sourceScope).toBe('unclear');
  });
});

describe('7. a single malformed item does not fail the whole analysis', () => {
  it('drops only the item with an invalid kind, keeps the rest', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [
          { id: 'item-1', title: 'Good fact', claim: 'C1', kind: 'fact', evidence: [] },
          { id: 'item-2', title: 'Bad item', claim: 'C2', kind: 'not_a_real_kind', evidence: [] },
          { id: 'item-3', title: 'Good inference', claim: 'C3', kind: 'inference', evidence: [] },
        ],
      })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items.map((i) => i.id)).toEqual(['item-1', 'item-3']);
  });

  it('does not fabricate evidence for a malformed evidence entry — it drops it instead', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({
        items: [
          {
            id: 'item-1',
            title: 'T',
            claim: 'C',
            kind: 'fact',
            evidence: [
              { segmentId: 'p1-s1', page: 1, quote: 'a real quote' },
              { segmentId: 'p1-s1', page: 1 /* missing quote */ },
              null,
            ],
          },
        ],
      })
    );
    const result = await runModuleAnalysis(baseArgs);
    expect(result.data.items[0].evidence).toEqual([{ segmentId: 'p1-s1', page: 1, quote: 'a real quote' }]);
  });
});

describe('8. very large paper input is sent whole, not crudely truncated', () => {
  it('every segment is included in the request content — no slice()-style cutoff', async () => {
    const manySegments = Array.from({ length: 400 }, (_, i) => ({
      id: `p${Math.floor(i / 10) + 1}-s${(i % 10) + 1}`,
      page: Math.floor(i / 10) + 1,
      text: `This is segment number ${i} with some representative sentence-length body text.`,
    }));

    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }] })
    );
    await runModuleAnalysis({ ...baseArgs, segments: manySegments });

    const sentRequest = mockCreate.mock.calls[0][0];
    const documentBlock = sentRequest.messages[0].content.find((c) => c.text?.includes('<document>'));
    for (const seg of manySegments) {
      expect(documentBlock.text).toContain(`id="${seg.id}"`);
    }
  });
});

describe('9. a failed re-analysis is detected as a failure (closes the loop with saveAnalysis\'s preserve-on-error fix)', () => {
  it('first call succeeds, second call (a re-analysis attempt) is truncated and rejects — never resolves as a fake empty success', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }] })
    );
    const first = await runModuleAnalysis(baseArgs);
    expect(first.data.items).toHaveLength(1);

    mockCreate.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      usage: { input_tokens: 28000, output_tokens: 4096 },
      content: [{ type: 'tool_use', name: 'record_analysis', input: {} }],
    });
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow();
    // (saveAnalysis's own "keep existing items on error" behavior is
    // covered separately in dataSafety.test.js — this test's job is just
    // to confirm the second attempt actually surfaces as a rejection for
    // that protection to have something to catch.)
  });
});

describe('10. first-ever analysis attempt fails', () => {
  it('rejects cleanly with no prior data to protect', async () => {
    const apiError = Object.assign(new Error('overloaded_error'), { status: 529 });
    mockCreate.mockRejectedValueOnce(apiError);
    await expect(runModuleAnalysis(baseArgs)).rejects.toThrow('overloaded_error');
  });
});

describe('client configuration', () => {
  it('requests use a finite per-request timeout instead of the SDK default (so a stuck request cannot hang indefinitely)', async () => {
    mockCreate.mockResolvedValueOnce(
      toolUseResponse({ items: [{ id: 'item-1', title: 'T', claim: 'C', kind: 'fact', evidence: [] }] })
    );
    await runModuleAnalysis(baseArgs);
    const requestOptions = mockCreate.mock.calls[0][1];
    expect(requestOptions?.timeout).toBeGreaterThan(0);
  });
});
