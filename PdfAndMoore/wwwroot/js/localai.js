// Free, private AI that runs on this computer's graphics chip (WebGPU) using WebLLM.
// The model downloads once (about 1–2 GB) and is then kept on the PC, so it works offline.
// Good for simple edits and short questions; Claude is smarter for long or tricky documents.

export const LOCAL_MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Fast (about 1 GB download)', vram: 1.7 },
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', label: 'Smarter (about 2 GB download)', vram: 2.6 },
];

let webllm = null;
let engine = null;
let engineModel = null;
let loading = null;

async function lib() {
  if (!webllm) webllm = await import('../lib/webllm/web-llm.js');
  return webllm;
}

/** Can this PC run the on-device AI? Returns {ok, reason}. */
export async function checkSupport() {
  if (!('gpu' in navigator)) return { ok: false, reason: "This computer's graphics driver doesn't offer WebGPU, which the on-device AI needs." };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'No compatible graphics chip was found for the on-device AI.' };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: 'WebGPU is not available: ' + e.message };
  }
}

export async function isDownloaded(modelId) {
  try {
    const w = await lib();
    return await w.hasModelInCache(modelId);
  } catch {
    return false;
  }
}

export function isLoaded(modelId) {
  return !!engine && engineModel === modelId;
}

/** Download (first time) and start the model. onProgress(fraction 0..1, text). */
export async function load(modelId, onProgress) {
  if (isLoaded(modelId)) return engine;
  if (loading) return loading;
  loading = (async () => {
    const w = await lib();
    if (engine) {
      try {
        await engine.unload();
      } catch {}
      engine = null;
    }
    engine = await w.CreateMLCEngine(modelId, {
      initProgressCallback: (r) => onProgress && onProgress(r.progress || 0, r.text || ''),
    });
    engineModel = modelId;
    return engine;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Ask for a JSON answer (used for edit commands). */
export async function askJson(modelId, system, user, onProgress) {
  const e = await load(modelId, onProgress);
  const res = await e.chat.completions.create({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: 700,
    response_format: { type: 'json_object' },
  });
  return res.choices[0].message.content || '';
}

/** Chat with streaming (used for questions about the document). */
export async function chat(modelId, messages, onText, onProgress) {
  const e = await load(modelId, onProgress);
  const stream = await e.chat.completions.create({ messages, temperature: 0.4, max_tokens: 900, stream: true });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk.choices[0]?.delta?.content || '';
    if (t) {
      full += t;
      onText && onText(t);
    }
  }
  return full;
}
