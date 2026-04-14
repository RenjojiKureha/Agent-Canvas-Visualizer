# 事件协议

## 必备字段
- `runId`: 一次 Agent 运行实例 ID
- `eventId`: 事件唯一 ID
- `seq`: 单 run 内单调递增序号
- `ts`: 事件时间戳
- `type`: 事件类型

## 事件类型
- `run_started`
- `node_created`
- `node_updated`
- `edge_created`
- `hitl_required`
- `hitl_applied`
- `run_finished`

## 协议约束
- 同一 run 必须保证 `seq` 严格递增。
- 客户端必须丢弃 `seq <= lastSeq` 的重复事件。
- SSE 重连后服务端按 `Last-Event-ID` 进行历史补发。
