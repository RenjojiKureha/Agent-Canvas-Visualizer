# 架构文档

## 1. 总体分层
- `packages/shared`: 事件协议 + 状态 reducer（单一事实来源）
- `apps/server`: 事件生产、SSE 推送、HITL 入口、事件回放
- `apps/web`: 事件消费、批处理状态同步、DAG 渲染与人工干预

## 2. 数据流
1. 前端调用 `POST /runs` 启动 run。
2. 后端生成事件并通过 `GET /runs/:id/stream` 持续推送。
3. 前端把事件入队，逐帧批处理，驱动 DAG 增量更新。
4. 命中 `hitl_required` 后，用户发起 `POST /runs/:id/intervene`。
5. 后端推送 `hitl_applied` 与后续事件，最终 `run_finished`。

## 3. 关键设计点
- 事件必须可重放（append-only）。
- 事件必须具备幂等键（`eventId`）与序列号（`seq`）。
- 前端状态必须由 reducer 统一演进，禁止组件散写状态。
- 高并发下优先保证“顺序一致性 + 增量绘制”。
