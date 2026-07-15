/**
 * HelloMinimax — Cloudflare Worker
 * OpenAI / Gemini / Claude compatible MiniMax Agent API proxy
 */
import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';

import { tokenSplit, getTokenLiveStatus } from './core';
import { createAgentCompletion, createAgentCompletionStream } from './chat';
import { createSpeech, createTranscriptions } from './audio';
import { createGeminiCompletion } from './gemini-adapter';
import { createClaudeCompletion } from './claude-adapter';
import modelMap from './model-map';

const app = new Hono();

// CORS
app.use('/*', cors());

// ---- Home ----
app.get('/', (c: Context) => c.text('HelloMinimax is running.'));

// ---- Ping ----
app.get('/ping', (c: Context) => c.text('pong'));

// ---- Models list ----
app.get('/v1/models', (c: Context) => {
  return c.json({
    data: [
      { id: 'MiniMax-M3', name: 'MiniMax-M3', object: 'model', owned_by: 'minimax', description: '最新旗舰模型，顶级推理与Agent能力' },
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', object: 'model', owned_by: 'minimax', description: '高性能平衡模型，兼顾速度与质量' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax-M2.7-highspeed', object: 'model', owned_by: 'minimax', description: '高速响应模型，适合高并发场景' },
    ],
  });
});

// ---- Token check ----
app.post('/token/check', async (c: Context) => {
  const body = await c.req.json();
  const { token } = body;
  if (!token) return c.json({ error: 'token is required' }, 400);
  const live = await getTokenLiveStatus(token);
  return c.json({ live });
});

// ---- Chat completions (OpenAI compatible) ----
app.post('/v1/chat/completions', async (c: Context) => {
  const body = await c.req.json();
  const authHeader = c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Authorization header is required' }, 401);
  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: 'messages array is required' }, 400);
  }

  const tokens = tokenSplit(authHeader);
  const token = tokens[Math.floor(Math.random() * tokens.length)];
  const { model = 'hailuo', conversation_id, messages, stream, tools, tool_choice } = body;

  if (stream) {
    const sseStream = await createAgentCompletionStream(model, messages, token, tools, tool_choice);
    return new Response(sseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } else {
    const result = await createAgentCompletion(model, messages, token, tools, tool_choice);
    return c.json(result);
  }
});

// ---- Audio speech (TTS) ----
app.post('/v1/audio/speech', async (c: Context) => {
  const body = await c.req.json();
  const authHeader = c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Authorization header is required' }, 401);
  if (!body.input) return c.json({ error: 'input is required' }, 400);
  if (!body.voice) return c.json({ error: 'voice is required' }, 400);

  const tokens = tokenSplit(authHeader);
  const token = tokens[Math.floor(Math.random() * tokens.length)];

  let { model = 'hailuo', input, voice } = body;

  // Voice mapping for OpenAI compatibility
  const ttsMap = modelMap['tts-1'] || {};
  if (voice in ttsMap) {
    voice = ttsMap[voice] || 'male-botong';
  }

  const audioBuffer = await createSpeech(model, input, voice, token);
  return new Response(audioBuffer, {
    headers: { 'Content-Type': 'audio/mpeg' },
  });
});

// ---- Audio transcriptions (STT) ----
app.post('/v1/audio/transcriptions', async (c: Context) => {
  const authHeader = c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Authorization header is required' }, 401);

  const tokens = tokenSplit(authHeader);
  const token = tokens[Math.floor(Math.random() * tokens.length)];

  // Parse multipart form
  const contentType = c.req.header('content-type') || '';
  let audioBuffer: ArrayBuffer;
  let filename = 'audio.mp3';

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return c.json({ error: 'File field is not set' }, 400);
    }
    audioBuffer = await file.arrayBuffer();
    filename = file.name || 'audio.mp3';
  } else if (contentType.includes('application/json')) {
    // Support base64 audio in JSON body
    const body = await c.req.json();
    if (!body.file) return c.json({ error: 'File field is not set' }, 400);

    const base64 = body.file.replace(/^data:[^;]+;base64,/, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    audioBuffer = bytes.buffer;
  } else {
    return c.json({ error: 'Unsupported content type' }, 400);
  }

  const { model = 'hailuo', response_format: responseFormat = 'json' } = await c.req.parseBody().catch(() => ({})) as any;

  const text = await createTranscriptions(model, audioBuffer, filename, token);
  return responseFormat === 'json' ? c.json({ text }) : c.text(text);
});

// ---- Gemini adapter ----
app.post('/v1beta/models/:model:generateContent', async (c: Context) => {
  const authHeader = c.req.header('x-goog-api-key') || c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Missing API key' }, 401);

  let auth = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  const tokens = tokenSplit(auth);
  const token = tokens[Math.floor(Math.random() * tokens.length)];

  const body = await c.req.json();
  if (!body.contents || !Array.isArray(body.contents)) {
    return c.json({ error: 'contents array is required' }, 400);
  }

  const model = (c.req.param('model') || 'gemini-pro').replace(/^models\//, '');
  const { contents, systemInstruction } = body;

  const response = await createGeminiCompletion(model, contents, systemInstruction, token, false);
  return c.json(response);
});

app.post('/v1beta/models/:model:streamGenerateContent', async (c: Context) => {
  const authHeader = c.req.header('x-goog-api-key') || c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Missing API key' }, 401);

  let auth = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  const tokens = tokenSplit(auth);
  const token = tokens[Math.floor(Math.random() * tokens.length)];

  const body = await c.req.json();
  if (!body.contents || !Array.isArray(body.contents)) {
    return c.json({ error: 'contents array is required' }, 400);
  }

  const model = (c.req.param('model') || 'gemini-pro').replace(/^models\//, '');
  const { contents, systemInstruction } = body;

  const stream = await createGeminiCompletion(model, contents, systemInstruction, token, true);
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
});

// Gemini models list
app.get('/v1beta/models', (c: Context) => {
  return c.json({
    models: [
      { name: 'models/gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', description: 'Most capable model' },
      { name: 'models/gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', description: 'Fast model' },
      { name: 'models/gemini-pro', displayName: 'Gemini Pro', description: 'Previous generation' },
      { name: 'models/hailuo', displayName: 'Hailuo (MiniMax)', description: 'Hailuo via MiniMax adapter' },
    ],
  });
});

// ---- Claude adapter ----
app.post('/v1/messages', async (c: Context) => {
  const authHeader = c.req.header('x-api-key') || c.req.header('authorization');

  if (!authHeader) return c.json({ error: 'Missing API key' }, 401);

  let auth = authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
  const tokens = tokenSplit(auth);
  const token = tokens[Math.floor(Math.random() * tokens.length)];

  const body = await c.req.json();
  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: 'messages array is required' }, 400);
  }

  const { model = 'hailuo', messages, system, stream = false } = body;

  if (stream) {
    const claudeStream = await createClaudeCompletion(model, messages, system, token, true);
    return new Response(claudeStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } else {
    const result = await createClaudeCompletion(model, messages, system, token, false);
    return c.json(result);
  }
});

export default app;
