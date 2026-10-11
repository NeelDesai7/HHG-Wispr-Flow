// The only outbound connection this app makes: Ollama, on this machine.

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const OLLAMA_URL = new URL(process.env.VACHAN_OLLAMA_URL || 'http://127.0.0.1:11434');
if (!LOOPBACK_NAMES.has(OLLAMA_URL.hostname)) {
  throw new Error(`Refusing to use Ollama at ${OLLAMA_URL.host}: it must run on this computer.`);
}

// Best fit for a laptop GPU first. e2b/e4b also understand audio, which a later step may use.
const PREFERRED = ['gemma4:e4b', 'gemma4:12b', 'gemma4:e2b', 'gemma4:26b', 'gemma4:31b'];

// Same options for loading and for every request, so Ollama never reloads the model between them.
// Vachan re-primes the model while it runs, so it unloads 30 minutes after Vachan stops.
const KEEP_ALIVE = '30m';
const OPTIONS = { temperature: 0, num_ctx: 8192 };

// Ollama can proxy "cloud" models that actually run on ollama.com. Those would break
// the no-cloud rule, so they are never picked, even if asked for by name.
export function isCloudModel(m) {
  return /(^|[:-])cloud\b/i.test(m.name) || Boolean(m.remote_host || m.remote_model);
}

export function pickModel(names, wanted) {
  if (wanted && names.includes(wanted)) return wanted;
  return PREFERRED.find((n) => names.includes(n)) ?? names[0] ?? null;
}

// OLLAMA_HOST=0.0.0.0 makes Ollama answer the whole network, not just this laptop.
function ollamaExposed() {
  const h = process.env.OLLAMA_HOST;
  return !!h && !/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?\/?$/i.test(h);
}

async function get(path) {
  const res = await fetch(new URL(path, OLLAMA_URL), { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`ollama ${path} → ${res.status}`);
  return res.json();
}

async function post(path, body, timeoutMs) {
  const res = await fetch(new URL(path, OLLAMA_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ollama ${path} → ${res.status}`);
  return data;
}

export async function ollamaStatus() {
  const base = { url: OLLAMA_URL.origin, exposedOnNetwork: ollamaExposed(), ollamaHost: process.env.OLLAMA_HOST || null };
  try {
    const [version, tags] = await Promise.all([get('/api/version'), get('/api/tags')]);
    const all = tags.models || [];
    const local = all.filter((m) => !isCloudModel(m));
    const gemma = local
      .filter((m) => /^gemma4(:|$)/.test(m.name))
      .map((m) => ({
        name: m.name,
        sizeGB: Number((m.size / 1e9).toFixed(1)),
        params: m.details?.parameter_size ?? null,
        quant: m.details?.quantization_level ?? null,
      }));
    return {
      ...base,
      reachable: true,
      version: version.version,
      gemma,
      model: pickModel(gemma.map((m) => m.name), process.env.VACHAN_MODEL),
      cloudModelsIgnored: all.filter(isCloudModel).map((m) => m.name),
    };
  } catch (err) {
    return { ...base, reachable: false, error: err.cause?.code || err.name, gemma: [], model: null, cloudModelsIgnored: [] };
  }
}

// An empty prompt loads the model into GPU memory without generating anything.
// The first load after Ollama starts can take a few minutes on this laptop.
export async function warm(model) {
  await post('/api/generate', { model, prompt: '', keep_alive: KEEP_ALIVE, options: OPTIONS }, 600_000);
}

const TRANSCRIBE_PROMPT = 'Transcribe this audio exactly, word for word, in the language that is actually spoken (it may be Hindi, Marathi, English, or a mix — write Hindi and Marathi in Devanagari). Output ONLY the transcription, no translation, no commentary.';

// Transcribes a clip with Gemma's on-device audio input. `wavBase64` is a 16 kHz mono WAV.
// The audio is sent to Ollama on this machine only and is never written anywhere.
export async function transcribeAudio(model, wavBase64, timeoutMs = 120_000) {
  const data = await post('/api/chat', {
    model,
    messages: [{ role: 'user', content: TRANSCRIBE_PROMPT, images: [wavBase64] }],
    stream: false,
    think: false,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0 },
  }, timeoutMs);
  return { text: (data.message?.content ?? '').trim(), stats: statsOf(data) };
}

const ms = (ns) => (typeof ns === 'number' ? Math.round(ns / 1e6) : null);

function statsOf(data) {
  return {
    loadMs: ms(data.load_duration),
    promptTokens: data.prompt_eval_count ?? null,
    promptMs: ms(data.prompt_eval_duration),
    outTokens: data.eval_count ?? null,
    outMs: ms(data.eval_duration),
  };
}

// Runs `messages` through the model once, generating a single token. This compiles the GPU
// kernels and leaves the shared prompt prefix in Ollama's cache, so the next real request
// only has to read its new lines.
export async function prime(model, messages) {
  const data = await post('/api/chat', {
    model, messages, stream: false, think: false, keep_alive: KEEP_ALIVE,
    options: { ...OPTIONS, num_predict: 1 },
  }, 600_000);
  return statsOf(data);
}

// One structured-output request, streamed. `schema` constrains the reply to JSON of that
// shape; `onText` receives each piece as it is generated, so callers can act before it ends.
export async function chatStream({ model, messages, schema, timeoutMs = 360_000, onText }) {
  const res = await fetch(new URL('/api/chat', OLLAMA_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, format: schema, stream: true, think: false, keep_alive: KEEP_ALIVE, options: OPTIONS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `ollama /api/chat → ${res.status}`);
  }
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  let last = {};
  for await (const chunk of res.body) {
    pending += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      const piece = msg.message?.content ?? '';
      if (piece) {
        content += piece;
        onText?.(piece);
      }
      if (msg.done) last = msg;
    }
  }
  return { content, stats: statsOf(last) };
}

// Ollama not running, or a request that never finished: worth retrying later.
export function isUnreachable(err) {
  const code = err.cause?.code;
  return err.name === 'TimeoutError' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
}
