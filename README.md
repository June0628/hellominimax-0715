# HelloMinimax
![认可linux.do](https://ld.xh.do/ld-badge.svg)

把 MiniMax Agent 网页版变为兼容 OpenAI / Gemini / Claude 的 API，部署在 Cloudflare Workers 上。

## 准备

- Node.js 18+
- Cloudflare 账号
- MiniMax 账号（[agent.minimaxi.com](https://agent.minimaxi.com)）

## 获取 Token

1. 浏览器打开 [agent.minimaxi.com](https://agent.minimaxi.com) 登录
2. F12 → Application → LocalStorage
3. 复制 `realUserID`（在 `user_detail_agent` 里）和 `_token`
4. 用 `+` 号拼接：`realUserID` + `+` + `_token`

## 部署

### Cloudflare Workers（推荐，免费）

```bash
npm install
npx wrangler login
npm run deploy
```

### 自己的服务器（Node.js）

```bash
npm install
npm start          # 或者 node --import tsx src/server.ts
```

默认端口 8000，可通过 `PORT` 环境变量修改：

```bash
PORT=3000 npm start
```

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8000
CMD ["npm", "start"]
```

```bash
docker build -t hellominimax .
docker run -d -p 8000:8000 hellominimax
```

## 使用

```bash
# 对话
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer realUserID+token" \
  -d '{"model":"MiniMax-M3","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 工具调用
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer realUserID+token" \
  -d '{
    "model":"MiniMax-M3",
    "messages":[{"role":"user","content":"北京天气"}],
    "tools":[{"type":"function","function":{"name":"get_weather","description":"获取天气","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    "stream":false
  }'

# 语音合成
curl -X POST https://your-worker.workers.dev/v1/audio/speech \
  -H "Authorization: Bearer realUserID+token" \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1","input":"你好世界","voice":"alloy"}' \
  --output audio.mp3
```

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/ping` | 健康检查 |
| POST | `/v1/chat/completions` | 对话（OpenAI 兼容） |
| POST | `/v1/audio/speech` | 语音合成 |
| POST | `/v1/audio/transcriptions` | 语音识别 |
| GET | `/v1/models` | 模型列表 |
| POST | `/token/check` | 验 Token |
| POST | `/v1/messages` | Claude 协议 |
| POST | `/v1beta/models/:model:generateContent` | Gemini 协议 |

## 客户端接入

**LobeChat / ChatGPT-Next-Web / Dify：** 选 OpenAI 兼容，API 地址填 `https://your-worker.workers.dev/v1`，API Key 填拼接后的 Token。

**Gemini CLI：**
```bash
export GEMINI_API_KEY="realUserID+token"
export GEMINI_API_BASE_URL="https://your-worker.workers.dev/v1beta"
gemini
```

**Claude Code：**
```bash
export ANTHROPIC_BASE_URL="https://your-worker.workers.dev"
export ANTHROPIC_API_KEY="realUserID+token"
claude
```

**多账号轮询：** 多个 Token 用逗号分隔。
```
Authorization: Bearer TOKEN1,TOKEN2,TOKEN3
```

## 本地开发

```bash
npm run dev
# → http://localhost:8787
```

## 免责声明

仅供学习研究，禁止商用。逆向 API 不稳定，建议去 [MiniMax 官方](https://platform.minimaxi.com) 付费使用。

学AI,上L站! 感谢LINUX DO社区的支持.
linux.do
