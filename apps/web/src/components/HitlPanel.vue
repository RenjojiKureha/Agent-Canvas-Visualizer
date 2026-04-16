<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { HitlContext } from "@acv/shared";
import ToolCallCard from "./ToolCallCard.vue";

const props = defineProps<{
  checkpointId: string;
  context?: HitlContext;
}>();

const emit = defineEmits<{
  (e: "decide", decision: string, note?: string, modifications?: Record<string, unknown>): void;
}>();

const note = ref("");
const modifiedArgs = ref<Record<string, unknown>>({});

// Reset state when checkpoint changes
watch(
  () => props.checkpointId,
  () => {
    note.value = "";
    modifiedArgs.value = {};
  },
);

const kind = computed(() => props.context?.kind || "answer_review");

const title = computed(() => {
  if (kind.value === "tool_approval") return `Tool Approval: ${props.context?.toolName}`;
  if (kind.value === "error_recovery") return "Error Recovery";
  return "Review Answer";
});

function decide(decision: string) {
  const mods = decision === "modify_args" ? modifiedArgs.value : undefined;
  emit("decide", decision, note.value.trim() || undefined, mods);
  note.value = "";
}

function onArgsUpdate(args: Record<string, unknown>) {
  modifiedArgs.value = args;
}
</script>

<template>
  <div class="hitl-panel">
    <div class="hitl-header">
      <span class="hitl-badge">{{ kind === "tool_approval" ? "&#9888;" : "&#9998;" }}</span>
      <span class="hitl-title">{{ title }}</span>
    </div>

    <div class="hitl-body">
      <template v-if="kind === 'tool_approval' && context?.toolName">
        <ToolCallCard
          :tool-name="context.toolName"
          :tool-args="context.toolArgs || {}"
          :editable="true"
          @update:args="onArgsUpdate"
        />
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('approve')">Approve</button>
          <button class="hitl-modify" @click="decide('modify_args')">Approve with Changes</button>
          <button class="hitl-reject" @click="decide('reject')">Reject</button>
        </div>
      </template>

      <template v-else-if="kind === 'answer_review'">
        <div v-if="context?.answer" class="hitl-answer-preview">
          <pre>{{ context.answer.slice(0, 500) }}{{ (context.answer.length ?? 0) > 500 ? "..." : "" }}</pre>
        </div>
        <textarea
          v-model="note"
          rows="2"
          class="hitl-note"
          placeholder="Optional: add your thoughts, or leave empty to let agent continue freely..."
        />
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('continue')">Continue</button>
          <button class="hitl-modify" @click="decide('revise')">Revise</button>
          <button class="hitl-finish" @click="decide('finish')">Finish</button>
        </div>
      </template>

      <template v-else-if="kind === 'error_recovery'">
        <div class="hitl-error-msg">{{ context?.errorMessage || "An error occurred." }}</div>
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('retry')">Retry</button>
          <button class="hitl-reject" @click="decide('abort')">Abort</button>
        </div>
      </template>

      <!-- Note input for non-answer-review panels (tool approval, error recovery) -->
      <textarea
        v-if="kind !== 'answer_review'"
        v-model="note"
        rows="2"
        class="hitl-note"
        placeholder="Optional note or feedback..."
      />
    </div>
  </div>
</template>

<style scoped>
.hitl-panel {
  border: 2px solid #f97316;
  border-radius: 10px;
  background: #fffbeb;
  overflow: hidden;
}
.hitl-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #fef3c7;
  border-bottom: 1px solid #fde68a;
  font-weight: 600;
  font-size: 14px;
}
.hitl-badge { font-size: 18px; }
.hitl-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hitl-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.hitl-approve {
  background: #16a34a; color: white; border: 0;
  padding: 8px 16px; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600;
}
.hitl-modify {
  background: #2563eb; color: white; border: 0;
  padding: 8px 16px; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600;
}
.hitl-reject {
  background: #dc2626; color: white; border: 0;
  padding: 8px 16px; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600;
}
.hitl-finish {
  background: #374151; color: white; border: 0;
  padding: 8px 16px; border-radius: 6px; cursor: pointer;
  font-size: 13px; font-weight: 600;
}
.hitl-note {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  background: #fff;
}
.hitl-answer-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  max-height: 120px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-family: "Cascadia Code", "Fira Code", monospace;
}
.hitl-error-msg {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  color: #dc2626;
  padding: 8px;
  border-radius: 6px;
  font-size: 13px;
}
.hitl-approve:hover, .hitl-modify:hover, .hitl-reject:hover, .hitl-finish:hover { opacity: 0.85; }
</style>
