<script setup lang="ts">
import type { GraphNode } from "@acv/shared";
import { roleColor, roleLabel, statusIndicator } from "../composables/dagLayout";

defineProps<{ node: GraphNode }>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="detail-panel">
    <div class="detail-header">
      <div class="detail-title">
        <span class="detail-badge" :style="{ background: roleColor(node.role) }">
          {{ roleLabel(node.role) }}
        </span>
        <span class="detail-id">{{ node.id }}</span>
        <span v-if="node.toolName" class="detail-tool">{{ node.toolName }}</span>
        <span class="detail-status" :style="{ color: statusIndicator(node.status) }">
          {{ node.status }}
        </span>
      </div>
      <button class="detail-close" @click="emit('close')" title="Esc">&times;</button>
    </div>
    <div class="detail-content">
      <pre>{{ node.content || "(empty)" }}</pre>
      <div v-if="node.toolArgs" class="detail-section">
        <div class="detail-section-title">Arguments:</div>
        <pre>{{ JSON.stringify(node.toolArgs, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: 440px;
  max-width: calc(100% - 24px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d1d9e6;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  z-index: 10;
}
.detail-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 14px; border-bottom: 1px solid #e5e7eb; flex-shrink: 0;
}
.detail-title { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.detail-badge { color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.detail-id { color: #6b7280; font-family: monospace; }
.detail-tool { color: #1d4ed8; font-family: monospace; font-weight: 600; font-size: 12px; }
.detail-status { font-weight: 600; font-size: 12px; }
.detail-close {
  background: none; border: 1px solid #d1d5db; border-radius: 6px;
  font-size: 18px; color: #6b7280; cursor: pointer;
  width: 28px; height: 28px; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.detail-close:hover { background: #f3f4f6; }
.detail-content { flex: 1; overflow-y: auto; padding: 14px; }
.detail-content pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.6;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace; color: #1f2937;
}
.detail-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
.detail-section-title { font-size: 12px; color: #6b7280; margin-bottom: 4px; font-weight: 600; }
</style>
