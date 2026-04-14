# Agent-Canvas-Visualizer

Agent 思考过程流式渲染引擎（MVP 骨架）。

## 项目目标
- 把 Agent 的 Thought / Action / Observation 过程标准化为事件流。
- 通过 SSE 进行低延迟推送与断线重连。
- 通过前端状态机进行高频增量更新和 DAG 可视化。
- 支持 Human-in-the-loop 干预与审计回放。

## 目录结构
- `apps/server`: Node.js + TypeScript SSE 服务端（兼容 OpenAI-like API）
- `apps/web`: Vue 3 + Pinia 前端可视化
- `packages/shared`: 前后端共享事件协议与 reducer
- `docs`: 架构、事件协议、HITL、路线图文档

## 环境变量
复制 `.env.example` 为 `.env`，推荐配置：
- `AGENT_API_KEY=你的密钥`
- `AGENT_MODEL=deepseek-chat`
- `AGENT_BASE_URL=https://api.deepseek.com`（按你的平台调整）
- `PORT=8787`

说明：后端已自动读取 `.env`，并保留 `OPENAI_*` 变量兼容。

## 快速开始
1. 安装依赖
   - `npm install`
2. 启动后端
   - `npm run dev:server`
3. 启动前端
   - `npm run dev:web`
4. 在页面输入 prompt，点击 `Start OpenAI Run`。

## API 一览
- `POST /runs`: 启动一次 run，Body: `{ "prompt": "..." }`
- `GET /runs/:id/stream`: SSE 流
- `POST /runs/:id/intervene`: 人工干预
- `GET /runs/:id/events`: 回放事件

更多细节见 `docs/`。
