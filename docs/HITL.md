# HITL 设计

## 检查点模型
- Agent 在关键决策处发出 `hitl_required`。
- 前端展示可选决策与上下文。
- 用户确认后调用 intervene 接口。
- 后端写入 `hitl_applied`，继续执行。

## 审计要求
- 记录操作人、checkpointId、决策值、备注、时间。
- 审计事件应可与 run 回放关联。

## UX 建议
- 明确提示当前暂停原因。
- 给出默认建议决策。
- 允许查看历史同类 checkpoint 的处理方式。
