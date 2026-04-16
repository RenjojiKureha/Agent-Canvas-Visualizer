import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { applyEvent, createInitialGraphState, type AgentEvent } from "@acv/shared";
import { connectRunStream, startRunRequest, interveneRequest, interruptRequest, type RunStreamHandle } from "../services/sse";

const STORAGE_KEY = "acv_activeRunId";

export const useAgentRunStore = defineStore("agent-run", () => {
  const graph = ref(createInitialGraphState());
  const queue = ref<AgentEvent[]>([]);
  /** True when the SSE connection is open but no events have arrived recently */
  const stale = ref(false);
  let raf = 0;
  let currentHandle: RunStreamHandle | null = null;
  let activeRunId: string | null = null;

  const nodes = computed(() => Object.values(graph.value.nodes));

  const currentCheckpoint = computed(() => {
    const entry = Object.entries(graph.value.checkpoints).find(([, c]) => !c.resolved);
    if (!entry) return null;
    return { checkpointId: entry[0], nodeId: entry[1].nodeId, context: entry[1].context };
  });

  const stepInfo = computed(() => ({
    current: graph.value.currentStep,
    max: graph.value.maxSteps,
  }));

  const isRunning = computed(() =>
    graph.value.runStatus === "streaming" || graph.value.runStatus === "resumed",
  );

  const resolvedCheckpoints = computed(() => {
    const result: Record<string, { decision: string }> = {};
    for (const [, cp] of Object.entries(graph.value.checkpoints)) {
      if (cp.resolved && cp.decision) {
        result[cp.nodeId] = { decision: cp.decision };
      }
    }
    return result;
  });

  function flush() {
    if (queue.value.length === 0) {
      raf = 0;
      return;
    }
    const batch = queue.value.splice(0, queue.value.length);
    for (const event of batch) graph.value = applyEvent(graph.value, event);
    // Any real event means connection is alive — clear stale flag
    stale.value = false;
    raf = requestAnimationFrame(flush);
  }

  function enqueue(event: AgentEvent) {
    // Guard against stale events from a previous run's stream
    if (activeRunId && event.runId !== activeRunId) return;
    queue.value.push(event);
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function closeStream() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (currentHandle) {
      currentHandle.cleanup();
      currentHandle.source.close();
      currentHandle = null;
    }
    stale.value = false;
  }

  function openStream(runId: string) {
    currentHandle = connectRunStream(
      runId,
      enqueue,
      () => {
        graph.value = { ...graph.value, runStatus: "error" };
        sessionStorage.removeItem(STORAGE_KEY);
      },
      () => {
        if (isRunning.value) stale.value = true;
      },
    );
  }

  function reconnect(runId: string) {
    closeStream();
    graph.value = createInitialGraphState();
    activeRunId = runId;
    openStream(runId);
  }

  function init() {
    const savedRunId = sessionStorage.getItem(STORAGE_KEY);
    if (savedRunId && !activeRunId) {
      reconnect(savedRunId);
    }
  }

  watch(
    () => graph.value.runStatus,
    (status) => {
      if (status === "finished" || status === "error") {
        closeStream();
        sessionStorage.removeItem(STORAGE_KEY);
      }
    },
  );

  async function startRun(prompt: string, projectPath?: string) {
    closeStream();
    graph.value = createInitialGraphState();
    const runId = await startRunRequest(prompt, projectPath);
    activeRunId = runId;
    sessionStorage.setItem(STORAGE_KEY, runId);
    openStream(runId);
  }

  async function intervene(
    checkpointId: string,
    decision: string,
    note?: string,
    modifications?: Record<string, unknown>,
  ) {
    if (!graph.value.runId) return;
    await interveneRequest(graph.value.runId, checkpointId, decision, note, modifications);
  }

  async function interrupt(type: string, content?: string) {
    const runId = graph.value.runId || activeRunId;
    if (!runId) return;
    await interruptRequest(runId, type, content);
  }

  return {
    graph,
    nodes,
    currentCheckpoint,
    resolvedCheckpoints,
    stepInfo,
    isRunning,
    stale,
    startRun,
    init,
    reconnect,
    intervene,
    interrupt,
    closeStream,
  };
});
