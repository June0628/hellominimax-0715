/**
 * Audio module - Text-to-Speech (TTS) and Speech-to-Text (STT)
 * Adapted for CF Workers (no sox transcoding)
 */
import { request, parseToken, acquireDeviceInfo } from './core';
import { createRepeatCompletion, removeConversation } from './chat';
import modelMap from './model-map';

const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;

/**
 * Text-to-Speech: create speech audio from text
 */
export async function createSpeech(
  model: string,
  input: string,
  voice: string,
  token: string
): Promise<Uint8Array> {
  // Get the repeat completion first to get convId and messageId
  const answer = await createRepeatCompletion(model, input.replace(/\n/g, '。'), token);
  const convId = answer.id;
  const messageId = answer.message_id;

  const { jwtToken, deviceInfo } = parseToken(token);

  // Map voice name
  if (modelMap[model]) {
    voice = modelMap[model][voice] || voice;
  }

  // Switch voice
  const switchResult = await request(
    'POST',
    '/v1/api/chat/update_robot_custom_config',
    { robotID: '1', config: { robotVoiceID: voice } },
    jwtToken,
    deviceInfo
  );
  const switchData = switchResult.data;
  if (switchData?.statusInfo?.code !== 0 && switchData?.statusInfo?.code !== undefined) {
    throw new Error(`Voice switch failed: ${switchData?.statusInfo?.message}`);
  }

  // Generate audio
  let requestStatus = 0;
  let audioUrls: string[] = [];
  const startTime = Date.now();

  while (requestStatus < 2) {
    if (Date.now() - startTime > 30000) throw new Error('Audio generation timeout');

    const result = await request(
      'GET',
      `/v1/api/chat/msg_tts?msgID=${messageId}&timbre=${voice}`,
      {},
      jwtToken,
      deviceInfo
    );
    const data = result.data;
    requestStatus = data?.requestStatus ?? 0;
    audioUrls = data?.result ?? [];
    if (requestStatus >= 2) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Remove conversation
  await removeConversation(convId, token).catch(() => {});

  if (!audioUrls.length) throw new Error('No audio generated');

  // Download all audio chunks
  const chunks: Uint8Array[] = [];
  for (const url of audioUrls) {
    const resp = await fetch(url, {
      headers: { 'Referer': 'https://hailuoai.com/' },
    });
    if (!resp.ok) throw new Error(`Audio download failed: [${resp.status}] ${resp.statusText}`);
    chunks.push(new Uint8Array(await resp.arrayBuffer()));
  }

  // Concatenate
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Speech-to-Text: transcribe audio file to text
 */
export async function createTranscriptions(
  model: string,
  audioBuffer: ArrayBuffer,
  filename: string,
  token: string
): Promise<string> {
  const { jwtToken, deviceInfo } = parseToken(token);

  return await attemptTranscription(model, audioBuffer, jwtToken, deviceInfo, 0);
}

async function attemptTranscription(
  model: string,
  audioBuffer: ArrayBuffer,
  token: string,
  deviceInfo: any,
  retryCount: number
): Promise<string> {
  try {
    const result = await request(
      'POST',
      '/v1/api/chat/phone_msg',
      {
        chatID: '0',
        voiceBytes: Array.from(new Uint8Array(audioBuffer)),
        characterID: '1',
        playSpeedLevel: '1',
      },
      token,
      deviceInfo,
      {
        headers: {
          'Accept': 'text/event-stream',
          'Referer': 'https://hailuoai.com/',
        },
      }
    );

    const data = result.data;
    if (data?.status_code === 1200041) return '';
    if (data?.status_code !== 0) {
      throw new Error(`Transcription error: ${data?.err_message}`);
    }

    return data?.data?.text || '';
  } catch (err: any) {
    if (retryCount < MAX_RETRY_COUNT) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
      return attemptTranscription(model, audioBuffer, token, deviceInfo, retryCount + 1);
    }
    throw err;
  }
}

export default { createSpeech, createTranscriptions };
