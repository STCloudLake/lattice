/**
 * OpenAI-compatible model client for the Lattice worker.
 *
 * Everything here runs inside the dedicated worker (or in Node during tests).
 * There is no chrome.* dependency: the provider configuration is passed in by
 * the page per call and never persisted by this module. In particular the API
 * key is used only to build one Authorization header — it is never logged,
 * never put into an error message, and never returned to the page.
 *
 * Wire format (works for DeepSeek, OpenAI, Ollama, LM Studio, …):
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer <key>            (omitted for local providers)
 *   {model, messages, temperature, max_tokens?, stream:false}
 *   -> choices[0].message.content
 */

export const DEFAULT_TIMEOUT_MS = 60000;

/** Hosts that may run without an API key (local model servers). */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

export const PROVIDER_PRESETS = ['deepseek', 'openai', 'local', 'custom'];

/** Chinese, stack-free, key-free error. The UI shows `message` verbatim. */
export class ProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

function nowMs() {
  if (globalThis.performance && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function parseBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new ProviderError('接口地址不是合法的 URL（例如 https://api.deepseek.com）');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('接口地址必须以 http:// 或 https:// 开头');
  }
  return url;
}

export function isLocalBaseUrl(baseUrl) {
  try {
    return LOCAL_HOSTS.has(new URL(String(baseUrl)).hostname);
  } catch {
    return false;
  }
}

/** `https://x/v1` -> `https://x/v1/models`; a full endpoint is kept. */
export function modelsEndpoint(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return trimmed.endsWith('/models') ? trimmed : `${trimmed}/models`;
}

/** `https://x/v1` -> `https://x/v1/chat/completions`; a full endpoint is kept. */
export function chatEndpoint(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Validates and normalizes the provider object coming from the page.
 * @returns {{preset: string, baseUrl: string, model: string, apiKey: string}}
 */
export function normalizeProvider(raw, options = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const preset = PROVIDER_PRESETS.includes(input.preset) ? input.preset : 'custom';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const disableThinking = input.disableThinking !== false;

  if (!baseUrl) throw new ProviderError('请先填写接口地址（例如 https://api.deepseek.com）');
  parseBaseUrl(baseUrl);
  if (options.requireModel !== false && !model) throw new ProviderError('请先填写模型名称（例如 deepseek-flash）');
  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new ProviderError('请先填写 API Key（本机接口可留空）');
  }
  return { preset, baseUrl, model, apiKey, disableThinking };
}

/** Human-readable label for the UI and the event actor: `deepseek-flash (deepseek)`. */
export function providerLabel(rawProvider) {
  const provider = normalizeProvider(rawProvider);
  return `${provider.model} (${provider.preset})`;
}

function sanitizeDetail(text, apiKey) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    const error = parsed && typeof parsed === 'object' ? parsed.error : null;
    if (error && typeof error === 'object' && typeof error.message === 'string') detail = error.message;
    else if (typeof parsed.message === 'string') detail = parsed.message;
    else if (typeof error === 'string') detail = error;
  } catch {
    detail = String(text ?? '');
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (apiKey) detail = detail.split(apiKey).join('***');
  return detail;
}

function httpErrorMessage(status, detail) {
  const suffix = detail ? ` · ${detail}` : '';
  switch (status) {
    case 400:
      return `模型拒绝了请求（HTTP 400）${suffix}`;
    case 401:
      return `API Key 无效或已过期（HTTP 401）${suffix}`;
    case 402:
      return `账户额度不足（HTTP 402）${suffix}`;
    case 403:
      return `没有访问该模型的权限（HTTP 403）${suffix}`;
    case 404:
      return `接口地址或模型不存在（HTTP 404）${suffix}`;
    case 429:
      return `请求过于频繁或额度不足（HTTP 429），请稍后再试${suffix}`;
    default:
      if (status >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后再试${suffix}`;
      return `模型请求失败（HTTP ${status}）${suffix}`;
  }
}

async function chatRequest(provider, body, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ProviderError('当前环境不支持网络请求');
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetchImpl(chatEndpoint(provider.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查接口地址或网络`);
      }
      throw new ProviderError('无法连接到接口地址（网络错误或地址不正确）');
    }

    let text;
    try {
      text = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查接口地址或网络`);
      }
      throw new ProviderError('读取模型响应失败（网络中断）');
    }

    if (!response.ok) {
      throw new ProviderError(httpErrorMessage(response.status, sanitizeDetail(text, provider.apiKey)), {
        status: response.status,
      });
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError('模型响应不是合法 JSON，请检查接口地址是否指向 OpenAI 兼容服务');
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderError('模型响应缺少内容（choices[0].message.content）');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Implements the extraction pipeline's LlmPort on top of one provider.
 * @param {object} rawProvider {preset, baseUrl, model, apiKey}
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 */
export function createLlmPort(rawProvider, options = {}) {
  const provider = normalizeProvider(rawProvider);
  return {
    model: provider.model,
    async complete(request) {
      const messages = Array.isArray(request?.messages) ? request.messages : [];
      if (messages.length === 0) throw new ProviderError('模型请求缺少 messages');
      const body = {
        model: provider.model,
        messages,
        temperature: typeof request.temperature === 'number' ? request.temperature : 0,
        stream: false,
      };
      if (Number.isFinite(request.maxTokens)) body.max_tokens = Math.round(request.maxTokens);
      // DeepSeek enables thinking (effort=high) by default and ignores temperature
      // there. Structured extraction does not benefit, so it is off by default.
      // Sent only for the DeepSeek preset: other OpenAI-compatible servers may
      // reject unknown body fields.
      if (provider.preset === 'deepseek') {
        body.thinking = { type: provider.disableThinking ? 'disabled' : 'enabled' };
      }
      return chatRequest(provider, body, options);
    },
  };
}

/**
 * "测试连接": one tiny chat completion; returns latency + model echo, or throws
 * a Chinese ProviderError.
 */
export async function testProvider(rawProvider, options = {}) {
  const port = createLlmPort(rawProvider, options);
  const startedAt = nowMs();
  const reply = await port.complete({
    messages: [{ role: 'user', content: '请只回复 OK 两个字母，不要输出其他内容。' }],
    temperature: 0,
    maxTokens: 8,
  });
  return {
    ok: true,
    latencyMs: Math.max(0, Math.round(nowMs() - startedAt)),
    model: port.model,
    reply: String(reply).trim().slice(0, 40),
  };
}

/**
 * Lists the models the endpoint actually serves. Model names change (DeepSeek
 * renamed `deepseek-chat` to `deepseek-flash`), so the UI must be able to ask
 * instead of hardcoding a list that rots.
 */
export async function listModels(rawProvider, options = {}) {
  const provider = normalizeProvider(rawProvider, { requireModel: false });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ProviderError('当前环境不支持网络请求');
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const endpoint = modelsEndpoint(provider.baseUrl);
  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new ProviderError(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查接口地址或网络`);
      }
      throw new ProviderError('无法连接到接口地址（网络错误或地址不正确）');
    }

    let text;
    try {
      text = await response.text();
    } catch {
      throw new ProviderError('读取模型列表失败（网络中断）');
    }
    if (!response.ok) {
      throw new ProviderError(httpErrorMessage(response.status, sanitizeDetail(text, provider.apiKey)), {
        status: response.status,
      });
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderError('模型列表不是合法 JSON，请检查接口地址是否指向 OpenAI 兼容服务');
    }
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const names = rows
      .map((row) => (typeof row === 'string' ? row : row && typeof row.id === 'string' ? row.id : row && typeof row.name === 'string' ? row.name : ''))
      .filter((name) => typeof name === 'string' && name.length > 0);
    const models = [...new Set(names)].sort();
    if (models.length === 0) throw new ProviderError('接口没有返回任何模型（/models）');
    return { models, count: models.length, endpoint };
  } finally {
    clearTimeout(timer);
  }
}
