<script setup lang="ts">
import { ref, computed, watch } from "vue";

const props = defineProps<{
  toolName: string;
  toolArgs: Record<string, unknown>;
  editable: boolean;
}>();

const emit = defineEmits<{
  (e: "update:args", args: Record<string, unknown>): void;
}>();

const argsText = ref(JSON.stringify(props.toolArgs, null, 2));
const parseError = ref("");

watch(
  () => props.toolArgs,
  (args) => {
    argsText.value = JSON.stringify(args, null, 2);
    parseError.value = "";
  },
);

function onInput() {
  try {
    const parsed = JSON.parse(argsText.value);
    parseError.value = "";
    emit("update:args", parsed);
  } catch {
    parseError.value = "Invalid JSON";
  }
}
</script>

<template>
  <div class="tool-card">
    <div class="tool-header">
      <span class="tool-icon">&#9881;</span>
      <span class="tool-name">{{ toolName }}</span>
    </div>
    <div class="tool-args">
      <div class="tool-args-label">Arguments:</div>
      <textarea
        v-if="editable"
        v-model="argsText"
        @input="onInput"
        class="tool-args-editor"
        rows="4"
        spellcheck="false"
      />
      <pre v-else class="tool-args-view">{{ argsText }}</pre>
      <div v-if="parseError" class="tool-parse-error">{{ parseError }}</div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: #f9fafb;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
}
.tool-icon { font-size: 16px; }
.tool-name { color: #1d4ed8; font-family: monospace; }
.tool-args-label { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.tool-args-editor {
  width: 100%;
  font-family: "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  resize: vertical;
  background: #fff;
  color: var(--text);
}
.tool-args-view {
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}
.tool-parse-error { color: #dc2626; font-size: 11px; margin-top: 4px; }
</style>
