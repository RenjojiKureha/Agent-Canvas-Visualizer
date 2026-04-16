<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import DagCanvas from "./components/DagCanvas.vue";
import HitlPanel from "./components/HitlPanel.vue";
import { useAgentRunStore } from "./stores/agentRun";

const store = useAgentRunStore();
onMounted(() => store.init());
onUnmounted(() => store.closeStream());
const prompt = ref("Please analyze this project structure and suggest improvements.");
const projectPath = ref("");
const loading = ref(false);
const error = ref("");
const reconnecting = ref(false);

const isRunning = computed(() => store.isRunning);
const checkpoint = computed(() => store.currentCheckpoint);
const stepInfo = computed(() => store.stepInfo);
const provider = computed(() => store.graph.provider);
const isApiMode = computed(() => provider.value === "api" || !provider.value);
const runStatus = computed(() => store.graph.runStatus);
const isStale = computed(() => store.stale);

const statusBanner = computed(() => {
  if (isStale.value && (runStatus.value === "streaming" || runStatus.value === "resumed")) {
    return { text: "Connection may be lost — no updates received for a while", cls: "status-stale" };
  }
  switch (runStatus.value) {
    case "streaming":
    case "resumed":
      return { text: "Agent is working...", cls: "status-working" };
    case "waiting_human":
      return { text: "Waiting for your decision", cls: "status-waiting" };
    case "finished":
      return { text: "Run completed", cls: "status-finished" };
    case "error":
      return { text: "Run failed", cls: "status-error" };
    default:
      return null;
  }
});

async function start() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    await store.startRun(prompt.value, projectPath.value || undefined);
  } catch (e: any) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function abort() {
  if (!confirm("Are you sure you want to abort the current run?")) return;
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

function tryReconnect() {
  if (reconnecting.value) return;
  const runId = store.graph.runId;
  if (!runId) return;
  reconnecting.value = true;
  store.reconnect(runId);
  setTimeout(() => { reconnecting.value = false; }, 2000);
}
</script>

<template>
  <!-- Top header -->
  <header class="header">
    <h1>Agent Canvas Visualizer</h1>
    <div class="btn-group">
      <button @click="start" :disabled="loading || isRunning">
        {{ loading ? "Starting..." : "Start Run" }}
      </button>
      <button class="danger" @click="abort" :disabled="!isRunning">
        Abort
      </button>
    </div>
  </header>

  <!-- Two-column body -->
  <div class="app-body">
    <!-- Left sidebar: controls & meta -->
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="field-label">Project Path</div>
        <input
          v-model="projectPath"
          type="text"
          :disabled="isRunning"
          placeholder="Leave empty for server's CWD"
          class="field-input mono"
        />
      </div>

      <div class="sidebar-section">
        <div class="field-label">Prompt</div>
        <textarea
          v-model="prompt"
          rows="5"
          :disabled="isRunning"
          class="field-input"
        />
      </div>

      <div class="sidebar-section">
        <div class="field-label">Run Info</div>
        <div class="meta">
          <span>run: {{ store.graph.runId?.slice(0, 8) || "-" }}</span>
          <span v-if="isApiMode">step: {{ stepInfo.current }}/{{ stepInfo.max || "?" }}</span>
          <span>{{ provider || "-" }}</span>
          <span>seq: {{ store.graph.lastSeq }}</span>
        </div>
      </div>

      <div v-if="error" class="sidebar-section">
        <div class="error-bar">{{ error }}</div>
      </div>
    </aside>

    <!-- Main canvas area -->
    <main class="canvas-area">
      <!-- Status bar -->
      <div v-if="statusBanner" class="canvas-status">
        <div :class="['status-banner', statusBanner.cls]" style="flex:1">
          {{ statusBanner.text }}
        </div>
        <button
          v-if="isStale"
          class="secondary"
          :disabled="reconnecting"
          @click="tryReconnect"
          style="flex-shrink:0"
        >
          {{ reconnecting ? "Reconnecting..." : "Reconnect" }}
        </button>
      </div>

      <!-- DAG canvas fills remaining space -->
      <DagCanvas :nodes="store.nodes" :edges="store.graph.edges" :decisions="store.resolvedCheckpoints" />

      <!-- HITL panel: floating overlay anchored to canvas bottom-center -->
      <transition name="hitl-fade">
        <div v-if="checkpoint" class="hitl-overlay">
          <HitlPanel
            :checkpoint-id="checkpoint.checkpointId"
            :context="checkpoint.context"
            @decide="onHitlDecide"
          />
        </div>
      </transition>
    </main>
  </div>
</template>

<style scoped>
.hitl-fade-enter-active, .hitl-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.hitl-fade-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
.hitl-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
</style>
