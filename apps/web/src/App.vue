<script setup lang="ts">
import { computed, ref } from "vue";
import DagCanvas from "./components/DagCanvas.vue";
import { useAgentRunStore } from "./stores/agentRun";

const store = useAgentRunStore();
const prompt = ref("请分析这个 Agent-Canvas-Visualizer 项目下一步落地计划，并给出 5 条可执行建议。");

const unresolvedCheckpoint = computed(() => {
  return Object.entries(store.graph.checkpoints).find(([, c]) => !c.resolved)?.[0];
});

async function start() {
  await store.startRun(prompt.value);
}

async function intervene(decision: string) {
  if (!unresolvedCheckpoint.value || !store.graph.runId) return;
  await store.intervene(unresolvedCheckpoint.value, decision);
}
</script>

<template>
  <main class="page">
    <section class="header">
      <h1>Agent Canvas Visualizer</h1>
      <div style="display: flex; gap: 8px">
        <button @click="start">Start Agent Run</button>
        <button
          class="secondary"
          :disabled="!unresolvedCheckpoint"
          @click="intervene('accept')"
        >
          HITL: Accept
        </button>
        <button
          class="secondary"
          :disabled="!unresolvedCheckpoint"
          @click="intervene('revise')"
        >
          HITL: Revise
        </button>
      </div>
    </section>

    <section class="panel" style="margin-bottom: 12px">
      <div style="font-size: 13px; color: var(--muted); margin-bottom: 6px">Prompt</div>
      <textarea
        v-model="prompt"
        rows="4"
        style="width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px; resize: vertical"
      />
    </section>

    <section class="panel">
      <div class="meta">
        <span>runId: {{ store.graph.runId || '-' }}</span>
        <span>status: {{ store.graph.runStatus }}</span>
        <span>lastSeq: {{ store.graph.lastSeq }}</span>
      </div>
      <DagCanvas :nodes="store.nodes" :edges="store.graph.edges" />
    </section>
  </main>
</template>
