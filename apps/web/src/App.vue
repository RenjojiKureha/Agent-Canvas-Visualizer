<script setup lang="ts">
import { computed, ref } from "vue";
import DagCanvas from "./components/DagCanvas.vue";
import HitlPanel from "./components/HitlPanel.vue";
import { useAgentRunStore } from "./stores/agentRun";

const store = useAgentRunStore();
const prompt = ref("Please analyze this project structure and suggest improvements.");
const loading = ref(false);
const error = ref("");

const isRunning = computed(() => store.isRunning);
const checkpoint = computed(() => store.currentCheckpoint);
const stepInfo = computed(() => store.stepInfo);

async function start() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    await store.startRun(prompt.value);
  } catch (e: any) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function abort() {
  error.value = "";
  try {
    await store.interrupt("abort");
  } catch (e: any) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onHitlDecide(decision: string, note?: string, modifications?: Record<string, unknown>) {
  if (!checkpoint.value) return;
  error.value = "";
  try {
    await store.intervene(checkpoint.value.checkpointId, decision, note, modifications);
  } catch (e: any) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <main class="page">
    <section class="header">
      <h1>Agent Canvas Visualizer</h1>
      <div class="btn-group">
        <button @click="start" :disabled="loading || isRunning">
          {{ loading ? "Starting..." : "Start Agent Run" }}
        </button>
        <button class="danger" @click="abort" :disabled="!isRunning">
          Abort
        </button>
      </div>
    </section>

    <div v-if="error" class="error-bar">{{ error }}</div>

    <section class="panel" style="margin-bottom: 12px">
      <div style="font-size: 13px; color: var(--muted); margin-bottom: 6px">Prompt</div>
      <textarea
        v-model="prompt"
        rows="3"
        :disabled="isRunning"
        style="width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px; resize: vertical"
      />
    </section>

    <section class="panel" style="margin-bottom: 12px">
      <div class="meta">
        <span>runId: {{ store.graph.runId || "-" }}</span>
        <span>status: {{ store.graph.runStatus }}{{ isRunning ? " ..." : "" }}</span>
        <span>step: {{ stepInfo.current }}/{{ stepInfo.max || "?" }}</span>
        <span>lastSeq: {{ store.graph.lastSeq }}</span>
      </div>
      <DagCanvas :nodes="store.nodes" :edges="store.graph.edges" />
    </section>

    <section v-if="checkpoint" style="margin-bottom: 12px">
      <HitlPanel
        :checkpoint-id="checkpoint.checkpointId"
        :context="checkpoint.context"
        @decide="onHitlDecide"
      />
    </section>
  </main>
</template>
