/**
 * Gemini API protocol adapter
 * Converts Gemini format ↔ MiniMax format
 */
import { createAgentCompletion, createAgentCompletionStream } from './chat';
import { uuid } from './util';

/**
 * Convert Gemini contents → MiniMax messages
 */
export function convertGeminiToMiniMax(contents: any[], systemInstruction?: any): any[] {
  const minimaxMessages: any[] = [];

  let systemText = '';
  if (systemInstruction) {
    if (typeof systemInstruction === 'string') {
      systemText = systemInstruction;
    } else if (systemInstruction.parts) {
      systemText = systemInstruction.parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('\n');
    }
  }

  let systemPrepended = false;

  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    let text = '';
    if (content.parts && Array.isArray(content.parts)) {
      text = content.parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('\n');
    }

    if (role === 'user' && systemText && !systemPrepended) {
      text = `${systemText}\n\n${text}`;
      systemPrepended = true;
    }

    minimaxMessages.push({ role, content: text });
  }

  return minimaxMessages;
}

/**
 * Convert MiniMax response → Gemini format
 */
export function convertMiniMaxToGemini(response: any): any {
  const content = response.choices[0].message.content;
  return {
    candidates: [
      {
        content: { parts: [{ text: content }], role: 'model' },
        finishReason: response.choices[0].finish_reason === 'stop' ? 'STOP' : 'MAX_TOKENS',
        index: 0,
        safetyRatings: [],
      },
    ],
    usageMetadata: {
      promptTokenCount: response.usage?.prompt_tokens || 0,
      candidatesTokenCount: response.usage?.completion_tokens || 0,
      totalTokenCount: response.usage?.total_tokens || 0,
    },
  };
}

/**
 * Convert MiniMax SSE stream → Gemini SSE stream
 */
export function convertMiniMaxStreamToGemini(minimaxStream: ReadableStream): ReadableStream {
  const reader = minimaxStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      const text = decoder.decode(value);
      const lines = text.split('\n');

      for (const line of lines) {
        if (!line.trim() || line.trim() === 'data: [DONE]') continue;

        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]) {
              const delta = data.choices[0].delta;

              if (delta.content) {
                const geminiChunk = {
                  candidates: [
                    {
                      content: { parts: [{ text: delta.content }], role: 'model' },
                      finishReason: null,
                      index: 0,
                      safetyRatings: [],
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`));
              }

              if (data.choices[0].finish_reason) {
                const finalChunk = {
                  candidates: [
                    {
                      content: { parts: [{ text: '' }], role: 'model' },
                      finishReason: 'STOP',
                      index: 0,
                      safetyRatings: [],
                    },
                  ],
                  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              }
            }
          } catch {
            // skip parse errors
          }
        }
      }
    },
  });
}

/**
 * Create Gemini completion
 */
export async function createGeminiCompletion(
  model: string,
  contents: any[],
  systemInstruction: any,
  token: string,
  stream: boolean
): Promise<any> {
  const minimaxMessages = convertGeminiToMiniMax(contents, systemInstruction);

  if (stream) {
    const minimaxStream = await createAgentCompletionStream(model, minimaxMessages, token);
    return convertMiniMaxStreamToGemini(minimaxStream);
  } else {
    const response = await createAgentCompletion(model, minimaxMessages, token);
    return convertMiniMaxToGemini(response);
  }
}
