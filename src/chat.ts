/**
 * Chat completions logic using MiniMax Agent API
 * Supports both stream (SSE) and non-stream modes via polling
 * Full OpenAI-compatible tool calling (function calling) support
 */
import {
  request,
  parseToken,
  acquireDeviceInfo,
  uploadFile,
  UploadedFile,
} from './core';
import { unixTimestamp, uuid } from './util';

const MAX_POLL_COUNT = 60;
const POLL_INTERVAL = 1000;

// Known MiniMax built-in tool names mapped from OpenAI function names
const KNOWN_MCP_TOOLS: Record<string, string> = {
  'web_search': 'web_search',
  'web_search_news': 'web_search_news',
  'web_fetch': 'web_fetch',
  'code_interpreter': 'code_interpreter',
};

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * Non-streaming chat completion via polling (with tool calling)
 */
export async function createAgentCompletion(
  model: string,
  messages: any[],
  token: string,
  tools?: ToolDef[],
  toolChoice?: string | { type: string; function: { name: string } }
): Promise<any> {
  const refFileUrls = extractRefFileUrls(messages);
  const refs: UploadedFile[] = refFileUrls.length
    ? await Promise.all(refFileUrls.map((url) => uploadFile(url, token)))
    : [];

  const { jwtToken, deviceInfo } = parseToken(token);

  // Step 1: Send message (with tool definitions injected)
  const sendResult = await request(
    'POST',
    '/matrix/api/v1/chat/send_msg',
    messagesPrepare(messages, refs, tools, toolChoice),
    jwtToken,
    deviceInfo
  );

  const sendData = sendResult.data;
  if (sendData?.base_resp?.status_code !== 0) {
    throw new Error(`Send message failed: ${sendData?.base_resp?.status_msg || 'Unknown error'}`);
  }

  const { chat_id } = sendData;

  // Step 2: Poll for AI response
  let pollCount = 0;
  let aiMessage: any = null;

  while (pollCount < MAX_POLL_COUNT) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    pollCount++;

    const detailResult = await request(
      'POST',
      '/matrix/api/v1/chat/get_chat_detail',
      { chat_id },
      jwtToken,
      deviceInfo
    );

    const detailData = detailResult.data;
    if (detailData?.base_resp?.status_code !== 0) continue;

    const chatMessages = detailData?.messages || [];
    aiMessage = chatMessages.find((m: any) => m.msg_type === 2);

    if (aiMessage) break;
  }

  if (!aiMessage) {
    throw new Error(`No AI response after ${MAX_POLL_COUNT} polls`);
  }

  const content = aiMessage.msg_content || '';

  // Try to parse tool calls from response
  const parsedToolCalls = parseToolCallFromContent(content);

  return {
    id: String(chat_id),
    model,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: parsedToolCalls
          ? {
              role: 'assistant',
              content: null,
              tool_calls: parsedToolCalls,
            }
          : {
              role: 'assistant',
              content: content,
            },
        finish_reason: parsedToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    created: unixTimestamp(),
  };
}

/**
 * Streaming chat completion via polling (with tool calling SSE deltas)
 */
export async function createAgentCompletionStream(
  model: string,
  messages: any[],
  token: string,
  tools?: ToolDef[],
  toolChoice?: string | { type: string; function: { name: string } }
): Promise<ReadableStream> {
  const refFileUrls = extractRefFileUrls(messages);
  const refs: UploadedFile[] = refFileUrls.length
    ? await Promise.all(refFileUrls.map((url) => uploadFile(url, token)))
    : [];

  const { jwtToken, deviceInfo } = parseToken(token);
  const created = unixTimestamp();

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const enqueue = (data: string) => {
        controller.enqueue(encoder.encode(data));
      };

      try {
        // Initial chunk
        enqueue(`data: ${JSON.stringify({
          id: '',
          model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created,
        })}\n\n`);

        // Step 1: Send message
        const sendResult = await request(
          'POST',
          '/matrix/api/v1/chat/send_msg',
          messagesPrepare(messages, refs, tools, toolChoice),
          jwtToken,
          deviceInfo
        );

        const sendData = sendResult.data;
        if (sendData?.base_resp?.status_code !== 0) {
          throw new Error(`Send message failed: ${sendData?.base_resp?.status_msg || 'Unknown'}`);
        }

        const chatId = sendData.chat_id;

        // Step 2: Poll for streaming-like output
        let pollCount = 0;
        let lastContent = '';
        let toolCallsStarted = false;

        while (pollCount < MAX_POLL_COUNT) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
          pollCount++;

          const detailResult = await request(
            'POST',
            '/matrix/api/v1/chat/get_chat_detail',
            { chat_id: chatId },
            jwtToken,
            deviceInfo
          );

          const detailData = detailResult.data;
          if (detailData?.base_resp?.status_code !== 0) continue;

          const chatMessages = detailData?.messages || [];
          const aiMessage = chatMessages.find((m: any) => m.msg_type === 2);

          if (aiMessage?.msg_content) {
            const currentContent = aiMessage.msg_content;
            if (currentContent.length > lastContent.length) {
              const newChunk = currentContent.substring(lastContent.length);
              
              // Detect if this starts to look like a tool call
              if (!toolCallsStarted && isToolCallStart(lastContent + newChunk)) {
                toolCallsStarted = true;
              }

              if (!toolCallsStarted) {
                // Regular text delta
                enqueue(`data: ${JSON.stringify({
                  id: String(chatId),
                  model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: newChunk }, finish_reason: null }],
                  created,
                })}\n\n`);
              }
              lastContent = currentContent;
            }

            if (pollCount > 3 && currentContent === lastContent) {
              break;
            }
          }
        }

        // Parse final content for tool calls
        const finalContent = lastContent;
        const parsedToolCalls = parseToolCallFromContent(finalContent);

        if (parsedToolCalls) {
          // Stream tool calls as delta
          for (let i = 0; i < parsedToolCalls.length; i++) {
            const tc = parsedToolCalls[i];
            enqueue(`data: ${JSON.stringify({
              id: String(chatId),
              model,
              object: 'chat.completion.chunk',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments,
                    },
                  }],
                },
                finish_reason: i === parsedToolCalls.length - 1 ? 'tool_calls' : null,
              }],
              created,
            })}\n\n`);
          }
        }

        // End chunk
        enqueue(`data: ${JSON.stringify({
          id: String(chatId),
          model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: parsedToolCalls ? 'tool_calls' : 'stop' }],
          created,
        })}\n\n`);
        enqueue('data: [DONE]\n\n');
        controller.close();
      } catch (err: any) {
        enqueue(`data: ${JSON.stringify({
          id: '',
          model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: `Error: ${err.message}` }, finish_reason: 'stop' }],
          created,
        })}\n\n`);
        enqueue('data: [DONE]\n\n');
        controller.close();
      }
    },
  });
}

/**
 * Sync repeat completion (used by TTS)
 */
export async function createRepeatCompletion(
  model: string,
  content: string,
  token: string
): Promise<any> {
  const { jwtToken, deviceInfo } = parseToken(token);

  content = content.replace(/[()（）【】\[\]{}「」『』〖〗《》<>〈〉#]/g, ' ');

  const result = await request(
    'POST',
    '/matrix/api/v1/chat/send_msg',
    messagesPrepare([
      { role: 'user', content: `user:完整复述以下内容,不要进行任何修改,也不需要进行任何解释。\n${content}\nassistant:好的,我将开始完整复述:\n` },
    ]),
    jwtToken,
    deviceInfo
  );

  const sendData = result.data;
  if (sendData?.base_resp?.status_code !== 0) {
    throw new Error(`Send message failed: ${sendData?.base_resp?.status_msg}`);
  }

  const { chat_id, msg_id } = sendData;

  let pollCount = 0;
  let aiMessage: any = null;

  while (pollCount < MAX_POLL_COUNT) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    pollCount++;

    const detailResult = await request(
      'POST',
      '/matrix/api/v1/chat/get_chat_detail',
      { chat_id },
      jwtToken,
      deviceInfo
    );

    const detailData = detailResult.data;
    if (detailData?.base_resp?.status_code !== 0) continue;

    aiMessage = detailData?.messages?.find((m: any) => m.msg_type === 2);
    if (aiMessage) break;
  }

  if (!aiMessage) throw new Error('No response for repeat completion');

  return {
    id: String(chat_id),
    message_id: String(msg_id),
    model,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: aiMessage.msg_content || '' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    created: unixTimestamp(),
  };
}

/**
 * Remove a conversation (best-effort)
 */
export async function removeConversation(convId: string, token: string): Promise<void> {
  try {
    const { jwtToken, deviceInfo } = parseToken(token);
    await request('DELETE', `/v1/api/chat/history/${convId}`, {}, jwtToken, deviceInfo);
  } catch {
    // Silently fail
  }
}

// --- Tool Call Helpers ---

/**
 * Parse tool call JSON from AI response content.
 * Supports multiple formats:
 * 1. <tool_call> or <function_call> XML-style wrapping
 * 2. ```json ``` code block with name/arguments
 * 3. Bare JSON object with name/arguments
 * 4. Fixes common JSON malformations (missing quotes, etc.)
 */
function parseToolCallFromContent(content: string): any[] | null {
  if (!content) return null;

  // Try <tool_call> or <function_call> XML-style wrapping
  const xmlMatch = content.match(/<(?:tool_call|function_call)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call)>/);
  if (xmlMatch) {
    return parseJsonToolCall(xmlMatch[1]);
  }

  // Try ```json or ``` code block
  const mdMatch = content.match(/```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/);
  if (mdMatch) {
    const result = parseJsonToolCall(mdMatch[1]);
    if (result) return result;
  }

  // Try bare JSON object wrapping with name/arguments at root level
  const bareMatch = content.match(/^\s*(\{[\s\S]*\})\s*$/);
  if (bareMatch) {
    const result = parseJsonToolCall(bareMatch[1]);
    if (result) return result;
  }

  return null;
}

function parseJsonToolCall(jsonStr: string): any[] | null {
  // Try direct parse first
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try fixing common JSON issues
    try {
      const fixed = fixCommonJsonIssues(jsonStr);
      parsed = JSON.parse(fixed);
    } catch {
      return null;
    }
  }

  // Support array of tool calls
  if (Array.isArray(parsed)) {
    const calls = parsed.map((item: any) => buildToolCall(item)).filter(Boolean);
    if (calls.length > 0 && calls[0].function.name) return calls;
  }

  // Single object
  const call = buildToolCall(parsed);
  if (call && call.function.name) return [call];

  return null;
}

/**
 * Build a single OpenAI-compatible tool_call from a parsed JSON object
 */
function buildToolCall(item: any): any | null {
  const name = item.name || item.function?.name || '';
  if (!name) return null;

  let args = item.arguments || item.function?.arguments || item.parameters || item.function?.parameters || {};
  if (typeof args !== 'string') {
    args = JSON.stringify(args);
  }

  return {
    id: item.id || `call_${uuid().substring(0, 24)}`,
    type: 'function' as const,
    function: { name, arguments: args },
  };
}

/**
 * Fix common JSON malformations from model output
 */
function fixCommonJsonIssues(json: string): string {
  let fixed = json.trim();

  // Fix missing quotes around property names: {name: "x"} -> {"name": "x"}
  fixed = fixed.replace(/(\{|\,\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*\:/g, '$1"$2":');

  // Fix single quotes used instead of double quotes (for values)
  // This is tricky - only fix obvious cases
  fixed = fixed.replace(/:\s*'([^']*)'/g, ': "$1"');

  return fixed;
}

function isToolCallStart(content: string): boolean {
  // Check if content looks like it might become a tool call
  return /^\s*(\{\s*"|<function_call>|```json)/.test(content.trim());
}

// --- Helpers ---

function extractRefFileUrls(messages: any[]): string[] {
  const urls: string[] = [];
  if (!messages.length) return urls;

  const lastMessage = messages[messages.length - 1];
  if (Array.isArray(lastMessage.content)) {
    for (const v of lastMessage.content) {
      if (typeof v !== 'object' || !['file', 'image_url'].includes(v.type)) continue;
      if (v.type === 'file' && v.file_url?.url) urls.push(v.file_url.url);
      else if (v.type === 'image_url' && v.image_url?.url) urls.push(v.image_url.url);
    }
  }
  return urls;
}

/**
 * Build a tool-use system prompt from OpenAI tool definitions
 */
function buildToolSystemPrompt(
  tools: ToolDef[],
  toolChoice?: string | { type: string; function: { name: string } }
): string {
  const toolDescriptions = tools.map((t) => {
    const f = t.function;
    return `## ${f.name}\n${f.description}\nParameters: ${JSON.stringify(f.parameters, null, 2)}`;
  }).join('\n\n');

  let prompt = `# Tools

You have access to the following functions. When you need to call a function, respond with a JSON object wrapped in <tool_call> tags. Do NOT include any other text outside the tags.

${toolDescriptions}

When you decide to call a function, respond ONLY with:
<tool_call>
{"name": "function_name", "arguments": {...}}
</tool_call>

`;

  // Handle tool_choice
  if (toolChoice) {
    if (toolChoice === 'none') {
      prompt += 'Do NOT call any functions. Respond with text only.\n';
    } else if (toolChoice === 'auto') {
      prompt += 'Call a function only when necessary.\n';
    } else if (typeof toolChoice === 'object' && toolChoice.function?.name) {
      prompt += `You MUST call the function "${toolChoice.function.name}".\n`;
    }
  }

  return prompt;
}

/**
 * Extract tool names that match MiniMax built-in MCP tools
 */
function getMcpToolNames(tools?: ToolDef[]): string[] {
  if (!tools) return [];
  return tools
    .map((t) => KNOWN_MCP_TOOLS[t.function.name])
    .filter(Boolean);
}

function messagesPrepare(
  messages: any[],
  refs: UploadedFile[] = [],
  tools?: ToolDef[],
  toolChoice?: string | { type: string; function: { name: string } }
): any {
  let content: string;

  // Build tool system prompt if tools provided
  const toolPrompt = tools && tools.length > 0
    ? buildToolSystemPrompt(tools, toolChoice)
    : '';

  if (messages.length < 2) {
    content = toolPrompt + messages.reduce((acc, m) => {
      if (Array.isArray(m.content)) {
        return m.content
          .filter((v: any) => typeof v === 'object' && v.type === 'text')
          .reduce((s: string, v: any) => s + (v.text || '') + '\n', acc);
      }
      return acc + `${m.content}\n`;
    }, '');
  } else {
    const merged = messages.reduce((acc, m) => {
      if (Array.isArray(m.content)) {
        return m.content
          .filter((v: any) => typeof v === 'object' && v.type === 'text')
          .reduce((s: string, v: any) => s + `${m.role}:${v.text || ''}\n`, acc);
      }
      return acc + `${m.role}:${m.content}\n`;
    }, '') + 'assistant:\n';

    content = (toolPrompt + merged).trim().replace(/\!\[.+\]\(.+\)/g, '');
  }

  // Extract known MCP tool names
  const mcpTools = getMcpToolNames(tools);

  return {
    msg_type: 1,
    text: content,
    chat_type: 1,
    attachments: refs.map((item) => ({
      file_type: item.fileType,
      file_id: item.fileId,
      file_name: item.filename,
    })),
    selected_mcp_tools: mcpTools,
    backend_config: {},
    sub_agent_ids: [],
  };
}
