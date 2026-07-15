/**
 * Claude API protocol adapter
 * Converts Claude Messages format ↔ MiniMax format
 */
import { createAgentCompletion, createAgentCompletionStream } from './chat';
import { uuid } from './util';

const MODEL_NAME = 'hailuo';

/**
 * Convert Claude messages → MiniMax messages
 */
export function convertClaudeToMiniMax(messages: any[], system?: string | any[]): any[] {
  const minimaxMessages: any[] = [];

  let systemText: string | undefined;
  if (system) {
    if (Array.isArray(system)) {
      systemText = system
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
    } else if (typeof system === 'string') {
      systemText = system;
    }
  }

  let systemPrepended = false;

  for (const msg of messages) {
    let content = msg.content;

    if (content === undefined || content === null) {
      content = '';
    } else if (Array.isArray(content)) {
      content = content
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
    }

    if (msg.role === 'user') {
      if (systemText && !systemPrepended) {
        content = `${systemText}\n\n${content}`;
        systemPrepended = true;
      }
      minimaxMessages.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      minimaxMessages.push({ role: 'assistant', content });
    }
  }

  return minimaxMessages;
}

/**
 * Convert MiniMax response → Claude format
 */
export function convertMiniMaxToClaude(response: any): any {
  const content = response.choices[0].message.content;
  return {
    id: response.id || uuid(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: MODEL_NAME,
    stop_reason: response.choices[0].finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Convert MiniMax SSE stream → Claude SSE stream
 */
export function convertMiniMaxStreamToClaude(minimaxStream: ReadableStream): ReadableStream {
  const reader = minimaxStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = uuid();
  let isFirstChunk = true;

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

              if (isFirstChunk) {
                controller.enqueue(encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: 'message_start',
                    message: {
                      id: messageId,
                      type: 'message',
                      role: 'assistant',
                      content: [],
                      model: MODEL_NAME,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: 0, output_tokens: 0 },
                    },
                  })}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                  })}\n\n`
                ));
                isFirstChunk = false;
              }

              if (delta.content) {
                controller.enqueue(encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta.content },
                  })}\n\n`
                ));
              }

              if (data.choices[0].finish_reason) {
                controller.enqueue(encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: 0,
                  })}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { output_tokens: 1 },
                  })}\n\n`
                ));
                controller.enqueue(encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify({
                    type: 'message_stop',
                  })}\n\n`
                ));
              }
            }
          } catch {
            // skip
          }
        }
      }
    },
  });
}

/**
 * Create Claude completion
 */
export async function createClaudeCompletion(
  model: string,
  messages: any[],
  system: string | any[] | undefined,
  token: string,
  stream: boolean
): Promise<any> {
  const minimaxMessages = convertClaudeToMiniMax(messages, system);

  if (stream) {
    const minimaxStream = await createAgentCompletionStream(model, minimaxMessages, token);
    return convertMiniMaxStreamToClaude(minimaxStream);
  } else {
    const response = await createAgentCompletion(model, minimaxMessages, token);
    return convertMiniMaxToClaude(response);
  }
}
