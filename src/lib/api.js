// api.js — Claude API access (browser-direct, BYO key), model list, and
// usage accounting. This is the only file that imports @anthropic-ai/sdk.
//
// Structured output strategy: we force a tool call (tool_choice) whose
// input_schema matches the shape we want (see prompts.js). The SDK already
// parses tool_use.input as JSON for us, so this is the primary path and
// needs no manual JSON parsing. If a (possibly custom) model doesn't
// return a tool_use block, we fall back to asking for raw JSON in the
// response text and parse that defensively (stripping ```json fences etc).

import Anthropic from '@anthropic-ai/sdk';
import {
  SYSTEM_PROMPT,
  COMPARISON_SYSTEM_PROMPT,
  ANALYSIS_TOOL,
  COMPARISON_TOOL,
  buildDocumentXml,
  buildModuleInstructions,
  buildCustomQuestionInstructions,
  buildComparisonUserContent,
  normalizeSourceScope,
  normalizeWeaknessType,
  normalizeAnalysisItems,
  normalizeComparisonFindings,
  validateComparisonStatus,
} from './prompts.js';
import { pruneComparisonItems } from './text.js';

// Per-request timeout. Generous on purpose — long papers with many
// analysis items legitimately take a while — but finite, so a genuinely
// stuck request surfaces as a clear "逾時" error instead of hanging
// against the SDK's own 10-minute default forever.
const REQUEST_TIMEOUT_MS = 120000;

// Comparison used to share the single-paper analysis default (8192) but
// was actually passed a LOWER explicit budget (4096) — backwards, since a
// comparison reasons over many analysis items across multiple papers and
// can legitimately produce more findings than one module's analysis.
// Raising this alone isn't the fix (a 10-paper comparison could still
// overflow it): the real fix is bounding the output SHAPE via the prompt
// (COMPARISON_SYSTEM_PROMPT's result-count and conciseness rules) and
// pruning input bloat (pruneComparisonItems) so what Claude has to reason
// about — and therefore how much it has to write — stays bounded
// regardless of how many papers are selected. This budget is just enough
// headroom for that bounded output to fit comfortably.
const COMPARISON_MAX_TOKENS = 8192;

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5（預設）' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'custom', label: '自訂 model ID...' },
];

export const DEFAULT_MODEL = 'claude-sonnet-5';

export function resolveModelId(settings) {
  if (!settings) return DEFAULT_MODEL;
  if (settings.model === 'custom') return (settings.customModel || '').trim() || DEFAULT_MODEL;
  return settings.model || DEFAULT_MODEL;
}

export function createClient(apiKey) {
  // maxRetries: 0 — the SDK defaults to silently retrying twice (with
  // backoff) on transient errors before we ever see a failure. For a
  // BYO-key personal tool that's an unexpected way to spend API credits;
  // per-request failures should surface immediately and let the user
  // decide to click "重新分析" themselves (see CLAUDE.md).
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
}

// ---------------------------------------------------------------------------
// Error translation — every thrown error surfaced to the UI goes through
// here so the user always sees a readable Traditional Chinese message
// instead of a raw SDK error.
// ---------------------------------------------------------------------------

export function translateApiError(err) {
  const msg = err?.message || String(err);

  if (typeof err?.status !== 'number') {
    // Not an SDK APIError (e.g. our own "please set an API key" / "bad AI
    // output format" errors) — the message is already user-facing zh-TW.
    if (err?.name === 'APIConnectionTimeoutError') {
      return 'API 請求逾時，請稍後再試。內容較長的論文可能需要較久時間分析。';
    }
    if (/CORS/i.test(msg) || err?.name === 'APIConnectionError') {
      return '無法連線到 Claude API，可能是網路問題或瀏覽器安全限制（CORS），請確認網路連線後再試。';
    }
    return msg;
  }

  if (err?.status === 401) {
    return 'API key 無效或驗證失敗，請至「設定」確認 API key 是否正確。';
  }
  if (err?.status === 403) {
    return '沒有權限使用此功能，請確認 Anthropic 帳號權限或 API key 是否正確。';
  }
  if (err?.status === 404) {
    return '找不到指定的模型，請確認模型 ID 是否正確（自訂模型可能尚未開放或拼字錯誤）。';
  }
  if (err?.status === 429) {
    return '已達到 API 速率限制，請稍後再重試。';
  }
  if (err?.status === 400 && /credit balance|insufficient/i.test(msg)) {
    return '帳戶額度不足，請至 Anthropic Console 儲值後再試。';
  }
  if (err?.status === 400) {
    return `請求格式有誤：${msg}`;
  }
  if (err.status >= 500) {
    return 'Claude 服務目前異常，請稍後再試。';
  }
  return `Claude API 錯誤（狀態碼 ${err.status}）：${msg}`;
}

export async function testApiConnection(apiKey, model) {
  if (!apiKey || !apiKey.trim()) {
    return { success: false, message: '請先輸入 API key。' };
  }
  try {
    const client = createClient(apiKey.trim());
    await client.messages.create(
      {
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      },
      { timeout: 30000 }
    );
    return { success: true, message: '連線成功，API key 與模型皆可正常使用。' };
  } catch (err) {
    return { success: false, message: translateApiError(err) };
  }
}

// ---------------------------------------------------------------------------
// Structured output helper
// ---------------------------------------------------------------------------

function extractUsage(response) {
  const u = response?.usage || {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
  };
}

function extractText(response) {
  return (response?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseJsonLoose(text) {
  if (!text) throw new Error('empty');
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('無法解析 JSON');
  }
}

const DEFAULT_TRUNCATED_MESSAGE =
  'AI 回應在完成前被截斷（超過單次回覆的長度上限），可能是這篇論文內容較長、產生的重點較多。請重新整理再試一次；若持續發生，可以嘗試縮小分析範圍（例如先取消排除以外的內容）。';

// A response cut off by max_tokens mid-tool-call is NOT a safe "success
// with less data" — the JSON the server hands back for `input` may be
// empty or missing keys entirely (it silently closed out whatever object
// it had so far), and treating that as a legitimate result was the root
// cause of a real bug: a long paper's analysis would come back with 0
// items, get saved as "done", and silently look like it was never
// analyzed at all — no error, nothing in the console, just a quiet
// revert to "尚未分析". So this must always throw here instead of
// returning to the caller as if it were a normal result. `message` lets
// callers give a context-appropriate explanation — the single-paper
// wording ("縮小分析範圍／排除內容") makes no sense for cross-paper
// comparison, which never re-reads any PDF at all.
function assertNotTruncated(response, message = DEFAULT_TRUNCATED_MESSAGE) {
  if (response?.stop_reason === 'max_tokens') {
    throw new Error(message);
  }
}

// Applies normalizeAnalysisItems to `data.items` when the tool's shape
// has an `items` field, and the equivalent array-shape guarantee to
// `data.findings` (COMPARISON_TOOL) — both the tool-use path and the
// plain-JSON fallback path go through here, since the fallback path in
// particular has no server-side schema validation at all. A tool shape
// with neither field passes through untouched, with `diagnostics: null`.
//
// Critical invariant: whenever `data` has an `items` (or `findings`) key,
// the RETURNED value under that key is *always* a real array — never an
// object, string, null, etc. A model (or the fallback JSON path) can
// return either as something other than a flat array (e.g. `items`
// grouped by category), and that must be treated as "zero usable
// entries", not passed through as-is — letting a non-array value reach
// the caller was the root cause of a real crash (`analysis.items.map is
// not a function`, see CLAUDE.md).
function normalizeStructuredData(data) {
  if (!data || typeof data !== 'object') {
    return { data, diagnostics: null };
  }
  if ('items' in data) {
    if (!Array.isArray(data.items)) {
      return {
        data: { ...data, items: [] },
        diagnostics: {
          rawItemCount: 0,
          normalizedItemCount: 0,
          rejections: [{ index: null, reason: 'items_not_an_array', value: typeof data.items }],
        },
      };
    }
    const rawItemCount = data.items.length;
    const { items, rejections } = normalizeAnalysisItems(data.items);
    return {
      data: { ...data, items },
      diagnostics: { rawItemCount, normalizedItemCount: items.length, rejections },
    };
  }
  if ('findings' in data) {
    if (!Array.isArray(data.findings)) {
      return {
        data: { ...data, findings: [] },
        diagnostics: {
          rawItemCount: 0,
          normalizedItemCount: 0,
          rejections: [{ index: null, reason: 'findings_not_an_array', value: typeof data.findings }],
        },
      };
    }
    // Comparison output: same per-item shape validation as analysis items
    // (normalizeComparisonFindings — rejects a finding only for a
    // structural problem: not an object, `type` outside COMPARISON_TYPES,
    // missing title/summary). This is what guarantees a `type:
    // 'difference'` finding is never silently dropped here just because
    // some older code elsewhere only knew about 3 types — COMPARISON_TYPES
    // is the single source of truth for the enum, and this is the only
    // place that checks against it. Source-ID whitelist validation
    // (verifyComparisonSources) happens later in ComparePage.jsx, once the
    // real per-paper item keys are known.
    const rawFindingCount = data.findings.length;
    const { findings, rejections } = normalizeComparisonFindings(data.findings);
    return {
      data: { ...data, findings },
      diagnostics: { rawItemCount: rawFindingCount, normalizedItemCount: findings.length, rejections },
    };
  }
  return { data, diagnostics: null };
}

async function callStructured(client, { model, system, userContent, tool, maxTokens = 8192, truncatedMessage }) {
  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  assertNotTruncated(response, truncatedMessage);

  const toolUseBlocks = (response.content || []).filter((b) => b.type === 'tool_use');
  const toolUse = toolUseBlocks.find((b) => b.name === tool.name);
  if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
    const { data, diagnostics } = normalizeStructuredData(toolUse.input);
    return {
      data,
      usage: extractUsage(response),
      diagnostics,
      source: 'tool_use',
      toolUseBlockCount: toolUseBlocks.length,
      stopReason: response.stop_reason,
    };
  }

  // Fallback: the model didn't return a tool_use block (can happen with
  // some custom / less-capable models). Ask for raw JSON instead.
  const fallbackResponse = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [
        {
          role: 'user',
          content: Array.isArray(userContent)
            ? [
                ...userContent,
                {
                  type: 'text',
                  text: `請只回傳一個 JSON 物件，且結構必須完全符合以下 JSON Schema，不要加上 markdown code fence、說明文字或任何其他內容：\n${JSON.stringify(
                    tool.input_schema
                  )}`,
                },
              ]
            : `${userContent}\n\n請只回傳一個 JSON 物件，且結構必須完全符合以下 JSON Schema，不要加上 markdown code fence、說明文字或任何其他內容：\n${JSON.stringify(
                tool.input_schema
              )}`,
        },
      ],
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  assertNotTruncated(fallbackResponse, truncatedMessage);

  const text = extractText(fallbackResponse);
  let rawData;
  try {
    rawData = parseJsonLoose(text);
  } catch {
    throw new Error('AI 回傳格式異常，請重新分析。');
  }
  const { data, diagnostics } = normalizeStructuredData(rawData);
  return {
    data,
    usage: extractUsage(fallbackResponse),
    diagnostics,
    source: 'fallback_json',
    toolUseBlockCount: toolUseBlocks.length,
    stopReason: fallbackResponse.stop_reason,
  };
}

// ---------------------------------------------------------------------------
// Public: analysis, custom question, comparison, OCR
// ---------------------------------------------------------------------------

export async function runModuleAnalysis({
  apiKey,
  model,
  segments,
  moduleId,
  researchBackground,
  comparisonTarget,
  focusTable,
}) {
  const client = createClient(apiKey);
  const documentXml = buildDocumentXml(segments);
  const instructions = buildModuleInstructions(moduleId, { researchBackground, comparisonTarget, focusTable });

  const userContent = [
    { type: 'text', text: documentXml, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: instructions },
  ];

  // Dev-only visibility into how big a request actually is, so a "why did
  // this fail" investigation doesn't start blind. Never includes the API
  // key or (deliberately) the document text itself — just size metrics.
  // estimatedTokens is a rough ~4 chars/token heuristic, not exact.
  if (import.meta.env.DEV) {
    const characters = documentXml.length + instructions.length;
    console.debug('[PaperLens] Analysis input:', {
      module: moduleId,
      segments: segments.length,
      characters,
      estimatedTokens: Math.round(characters / 4),
    });
  }

  const result = await callStructured(client, { model, system: SYSTEM_PROMPT, userContent, tool: ANALYSIS_TOOL });

  // The 數據細節 (data) module is the only one that asks Claude for
  // sourceScope. Normalize it here so whatever gets saved is always one of
  // the four valid values — a model that omits the field, or returns
  // something else entirely, never breaks the analysis or crashes the UI.
  if (moduleId === 'data' && Array.isArray(result.data?.items)) {
    result.data = {
      ...result.data,
      items: result.data.items.map((item) => ({ ...item, sourceScope: normalizeSourceScope(item.sourceScope) })),
    };
  }

  // Same idea for 弱點與延伸 (limitations): weaknessType has no catch-all
  // "unclear" value, so a missing/invalid one just normalizes to
  // undefined — the UI then simply skips the second badge for that item.
  if (moduleId === 'limitations' && Array.isArray(result.data?.items)) {
    result.data = {
      ...result.data,
      items: result.data.items.map((item) => ({ ...item, weaknessType: normalizeWeaknessType(item.weaknessType) })),
    };
  }

  const finalItemCount = Array.isArray(result.data?.items) ? result.data.items.length : 0;

  if (import.meta.env.DEV) {
    console.debug('[module analysis debug]', {
      module: moduleId,
      'raw response type': result.source,
      'tool_use blocks': result.toolUseBlockCount,
      'raw item count': result.diagnostics?.rawItemCount ?? 0,
      // JSON parsing is all-or-nothing in this pipeline (tool_use.input is
      // already parsed for us by the SDK; the fallback path either fully
      // parses or throws before we get any count at all) — so there is no
      // distinct "parsed but not yet normalized" stage separate from raw.
      'parsed item count': result.diagnostics?.rawItemCount ?? 0,
      'normalized item count': result.diagnostics?.normalizedItemCount ?? 0,
      'rejected item count': result.diagnostics?.rejections?.length ?? 0,
      'final item count': finalItemCount,
      rejectReasons: result.diagnostics?.rejections ?? [],
    });
  }

  // A "successful" API call that ends up with zero usable items is NOT a
  // successful analysis and must never be saved as status: "done" — that
  // was the actual product bug (see CLAUDE.md): status=done + items=[] +
  // error=null looks, from the UI's perspective, indistinguishable from
  // "never analyzed", so the failure was completely invisible. This
  // covers every way the count can land on 0 — a truncated response
  // (already usually caught earlier by assertNotTruncated), Claude
  // genuinely returning an empty items array in an otherwise complete
  // response, or normalizeAnalysisItems() rejecting every single item.
  // None of the five analysis modules has a legitimate "0 items is a
  // correct result" case.
  if (finalItemCount === 0) {
    throw new Error('Claude 已回應，但沒有產生可用的分析結果。請重試。');
  }

  return result;
}

export async function runCustomQuestion({ apiKey, model, segments, question, researchBackground }) {
  const client = createClient(apiKey);
  const documentXml = buildDocumentXml(segments);
  const instructions = buildCustomQuestionInstructions(question, { researchBackground });

  const userContent = [
    { type: 'text', text: documentXml, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: instructions },
  ];

  return callStructured(client, { model, system: SYSTEM_PROMPT, userContent, tool: ANALYSIS_TOOL });
}

const COMPARISON_TRUNCATED_MESSAGE =
  '比較結果太長，AI 回應在完成前被截斷。可以減少比較論文數量，或填寫「聚焦問題」縮小比較範圍後再試一次。';

export async function runComparison({ apiKey, model, items, focusQuestion }) {
  const client = createClient(apiKey);
  // Comparison input bloat (duplicate claims across items, repeated
  // "not_mentioned" gaps piling up per paper/module) grows the prompt
  // without adding comparison value — prune before it ever reaches the
  // prompt builder, not after, so the set of sourceIds Claude is allowed
  // to cite exactly matches what verifyComparisonSources() will accept.
  const prunedItems = pruneComparisonItems(items);
  const userContent = buildComparisonUserContent(prunedItems, focusQuestion);
  const characters = userContent.length;

  const result = await callStructured(client, {
    model,
    system: COMPARISON_SYSTEM_PROMPT,
    userContent,
    tool: COMPARISON_TOOL,
    maxTokens: COMPARISON_MAX_TOKENS,
    truncatedMessage: COMPARISON_TRUNCATED_MESSAGE,
  });

  // Claude's own comparisonStatus/emptyReason must agree with what it
  // actually produced (see validateComparisonStatus's comment in
  // prompts.js) — a self-inconsistent response (e.g. `findings: []` but
  // comparisonStatus="compared", or insufficient_overlap with no
  // emptyReason) is malformed and must not be silently accepted as either
  // a normal result or a legitimate empty one.
  const findingsCount = Array.isArray(result.data?.findings) ? result.data.findings.length : 0;
  const statusCheck = validateComparisonStatus({
    comparisonStatus: result.data?.comparisonStatus,
    emptyReason: result.data?.emptyReason,
    findingsCount,
  });

  // Dev-only visibility, mirroring the "[PaperLens] Analysis input:" log
  // above — never logs the API key, full paper text, or the assembled
  // prompt itself, only size metrics needed to investigate a max_tokens
  // failure without guessing.
  if (import.meta.env.DEV) {
    console.debug('[PaperLens] Comparison input:', {
      papers: new Set(prunedItems.map((it) => it.paperId)).size,
      analysisItems: prunedItems.length,
      characters,
      estimatedInputTokens: Math.round(characters / 4),
      maxOutputTokens: COMPARISON_MAX_TOKENS,
      stopReason: result.stopReason,
      comparisonStatus: result.data?.comparisonStatus,
      comparisonStatusValid: statusCheck.valid,
    });
  }

  if (!statusCheck.valid) {
    throw new Error(
      'AI 回傳的比較結果狀態不一致（comparisonStatus 與 findings 數量或 emptyReason 不符），這是格式錯誤，不是正常的比較結果。請重新嘗試比較一次。'
    );
  }

  return result;
}

const OCR_SYSTEM_PROMPT = `你是 PaperLens 的 OCR 助手。使用者會提供一張學術論文頁面的圖片，請盡可能精確地把圖片中的文字逐字轉錄出來。

規則：
- 依照正常閱讀順序（通常由上到下、由左到右；若為雙欄排版，先讀完左欄再讀右欄）輸出文字。
- 不要翻譯、摘要或補充說明，只需要逐字轉錄。
- 不同段落之間請用一個空白行分隔。
- 圖表中的文字、頁碼、頁首頁尾可以省略。
- 只輸出轉錄出來的文字本身，不要加上任何前言、說明或 markdown 格式。`;

export async function runOcrPage({ apiKey, model, dataUrl, pageNumber }) {
  const client = createClient(apiKey);
  const [, mediaTypePart, base64Data] = dataUrl.match(/^data:(.+);base64,(.*)$/s) || [];
  if (!base64Data) throw new Error('OCR 圖片格式錯誤。');

  const response = await client.messages.create(
    {
      model,
      max_tokens: 4096,
      system: OCR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaTypePart, data: base64Data },
            },
            { type: 'text', text: `這是論文第 ${pageNumber} 頁，請轉錄頁面上的文字。` },
          ],
        },
      ],
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );

  return { text: extractText(response), usage: extractUsage(response) };
}
