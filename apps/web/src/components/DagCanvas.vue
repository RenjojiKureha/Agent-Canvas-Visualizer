<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";

type LayoutNode = GraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  header: string;
  lines: string[];
  truncated: boolean;
  totalLines: number;
  fillColor: string;
  statusColor: string;
};

type LayoutEdge = GraphEdge & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const PREVIEW_LINES = 6;
const MAX_CHARS_PER_LINE = 44;
const NODE_WIDTH = 360;
const NODE_GAP_Y = 24;
const BRANCH_GAP_X = 56;

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
}>();

const selectedNodeId = ref<string | null>(null);
const dagContainerRef = ref<HTMLElement | null>(null);

const selectedNode = computed(() => {
  if (!selectedNodeId.value) return null;
  return props.nodes.find((n) => n.id === selectedNodeId.value) ?? null;
});

function selectNode(id: string) {
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}

function closeDetail() {
  selectedNodeId.value = null;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && selectedNodeId.value) closeDetail();
}

onMounted(() => document.addEventListener("keydown", onKeyDown));
onUnmounted(() => document.removeEventListener("keydown", onKeyDown));

const prevNodeCount = ref(0);
watch(
  () => props.nodes.length,
  (count) => {
    if (count > prevNodeCount.value && dagContainerRef.value) {
      nextTick(() => {
        const el = dagContainerRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    prevNodeCount.value = count;
  },
);

function roleColor(role: GraphNode["role"]): string {
  switch (role) {
    case "thinking": return "#0f766e";
    case "tool_call": return "#1d4ed8";
    case "tool_result": return "#7c3aed";
    case "answer": return "#16a34a";
    case "hitl": return "#ea580c";
    case "error": return "#dc2626";
    default: return "#6b7280";
  }
}

function roleLabel(role: GraphNode["role"]): string {
  switch (role) {
    case "thinking": return "Thinking";
    case "tool_call": return "Tool Call";
    case "tool_result": return "Result";
    case "answer": return "Answer";
    case "hitl": return "HITL";
    case "error": return "Error";
    default: return String(role);
  }
}

function statusIndicator(status: GraphNode["status"]): string {
  switch (status) {
    case "streaming": return "#facc15";
    case "done": return "#22c55e";
    case "error": return "#ef4444";
    case "waiting_human": return "#f97316";
    default: return "#94a3b8";
  }
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
  return out;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function nodeHeight(n: GraphNode): number {
  const rawLines = (n.content || "").split(/\r?\n/);
  const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
  const lineCount = Math.min(allWrapped.length, PREVIEW_LINES + 1);
  return 40 + Math.max(lineCount, 1) * 16 + 14;
}

const layout = computed(() => {
  const mainRoles = new Set(["thinking", "answer", "error"]);
  const mainCol: GraphNode[] = [];
  const branches = new Map<string, GraphNode[]>();

  for (const n of props.nodes) {
    if (mainRoles.has(n.role)) {
      mainCol.push(n);
    } else if (n.parentId) {
      const list = branches.get(n.parentId) || [];
      list.push(n);
      branches.set(n.parentId, list);
    } else {
      mainCol.push(n);
    }
  }

  const posMap = new Map<string, { x: number; y: number }>();
  let cursorY = 24;
  const mainX = 32;

  for (const n of mainCol) {
    posMap.set(n.id, { x: mainX, y: cursorY });
    const h = nodeHeight(n);

    const branchNodes = branches.get(n.id) || [];
    let branchY = cursorY;
    for (const bn of branchNodes) {
      const bx = mainX + NODE_WIDTH + BRANCH_GAP_X;
      posMap.set(bn.id, { x: bx, y: branchY });

      const subBranch = branches.get(bn.id) || [];
      let subY = branchY;
      for (const sbn of subBranch) {
        const sx = bx + NODE_WIDTH + BRANCH_GAP_X;
        posMap.set(sbn.id, { x: sx, y: subY });
        subY += nodeHeight(sbn) + NODE_GAP_Y;
      }
      branchY += Math.max(nodeHeight(bn), subY - branchY) + NODE_GAP_Y;
    }

    cursorY += Math.max(h, branchY - cursorY) + NODE_GAP_Y;
  }

  const nodes: LayoutNode[] = props.nodes.map((n) => {
    const pos = posMap.get(n.id) || { x: mainX, y: 24 };
    const statusLabel = n.status === "streaming" ? "streaming..."
      : n.status === "waiting_human" ? "waiting"
      : n.status;
    const header = `${roleLabel(n.role)} · ${statusLabel}`;
    const rawLines = (n.content || "").split(/\r?\n/);
    const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
    const totalLines = allWrapped.length;
    const truncated = allWrapped.length > PREVIEW_LINES;
    const lines = truncated
      ? [...allWrapped.slice(0, PREVIEW_LINES), `... ${totalLines} lines total`]
      : allWrapped;

    const longest = Math.max(header.length, ...lines.map((l) => l.length), 12);
    const width = clamp(26 + longest * 7.2, 200, NODE_WIDTH);
    const height = 40 + Math.max(lines.length, 1) * 16 + 14;

    return {
      ...n,
      x: pos.x,
      y: pos.y,
      width,
      height,
      header,
      lines,
      truncated,
      totalLines,
      fillColor: roleColor(n.role),
      statusColor: statusIndicator(n.status),
    };
  });

  const nodePos = new Map(nodes.map((nd) => [nd.id, nd]));
  const edges: LayoutEdge[] = props.edges
    .map((e) => {
      const from = nodePos.get(e.from);
      const to = nodePos.get(e.to);
      if (!from || !to) return null;
      const isHorizontal = Math.abs(from.x - to.x) > NODE_WIDTH / 2;
      return {
        ...e,
        x1: isHorizontal ? from.x + from.width : from.x + from.width / 2,
        y1: isHorizontal ? from.y + from.height / 2 : from.y + from.height,
        x2: isHorizontal ? to.x : to.x + to.width / 2,
        y2: isHorizontal ? to.y + to.height / 2 : to.y,
      };
    })
    .filter((e): e is LayoutEdge => Boolean(e));

  const svgWidth = Math.max(980, ...nodes.map((nd) => nd.x + nd.width + 40));
  const svgHeight = Math.max(620, ...nodes.map((nd) => nd.y + nd.height + 40));

  return { nodes, edges, svgWidth, svgHeight };
});

function edgePath(e: LayoutEdge): string {
  const dx = Math.abs(e.x2 - e.x1);
  const dy = Math.abs(e.y2 - e.y1);

  if (dx > dy) {
    const cp = Math.max(dx * 0.4, 30);
    return `M ${e.x1} ${e.y1} C ${e.x1 + cp} ${e.y1}, ${e.x2 - cp} ${e.y2}, ${e.x2} ${e.y2}`;
  } else {
    const cp = Math.max(dy * 0.4, 20);
    return `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + cp}, ${e.x2} ${e.y2 - cp}, ${e.x2} ${e.y2}`;
  }
}
</script>

<template>
  <div class="dag-wrapper">
    <div ref="dagContainerRef" class="dag-container" :class="{ 'has-detail': selectedNode }">
      <svg :width="layout.svgWidth" :height="layout.svgHeight" class="dag-svg">
        <defs>
          <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3 L 0 6 z" fill="#94a3b8" />
          </marker>
        </defs>

        <g v-for="e in layout.edges" :key="e.id">
          <path :d="edgePath(e)"
            fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)" />
        </g>

        <g v-for="n in layout.nodes" :key="n.id"
          class="dag-node"
          :class="{ selected: selectedNodeId === n.id, streaming: n.status === 'streaming' }"
          @click="selectNode(n.id)">

          <rect :x="n.x" :y="n.y" rx="10" ry="10"
            :width="n.width" :height="n.height"
            :fill="n.fillColor" class="node-bg" />

          <rect v-if="selectedNodeId === n.id"
            :x="n.x - 2" :y="n.y - 2" rx="12" ry="12"
            :width="n.width + 4" :height="n.height + 4"
            fill="none" stroke="#facc15" stroke-width="2.5" />

          <circle v-if="n.status === 'streaming'"
            :cx="n.x + n.width - 14" :cy="n.y + 16" r="8"
            fill="none" :stroke="n.statusColor" stroke-width="1.5"
            class="pulse-ring" />

          <circle :cx="n.x + n.width - 14" :cy="n.y + 16" r="5" :fill="n.statusColor" />

          <text :x="n.x + 12" :y="n.y + 20" fill="white" font-size="12" font-weight="600">
            {{ n.header }}
          </text>

          <line :x1="n.x + 8" :y1="n.y + 28" :x2="n.x + n.width - 8" :y2="n.y + 28"
            stroke="rgba(255,255,255,0.25)" stroke-width="1" />

          <text
            v-for="(line, idx) in n.lines"
            :key="`${n.id}-${idx}`"
            :x="n.x + 12"
            :y="n.y + 44 + idx * 16"
            :fill="n.truncated && idx === n.lines.length - 1 ? 'rgba(250,204,21,0.9)' : 'rgba(255,255,255,0.92)'"
            :font-size="n.truncated && idx === n.lines.length - 1 ? '10.5' : '11.5'"
            :font-style="n.truncated && idx === n.lines.length - 1 ? 'italic' : 'normal'"
          >
            {{ line }}
          </text>
        </g>
      </svg>
    </div>

    <transition name="slide">
      <div v-if="selectedNode" class="detail-panel">
        <div class="detail-header">
          <div class="detail-title">
            <span class="detail-badge" :style="{ background: roleColor(selectedNode.role) }">
              {{ roleLabel(selectedNode.role) }}
            </span>
            <span class="detail-id">{{ selectedNode.id }}</span>
            <span v-if="selectedNode.toolName" class="detail-tool">{{ selectedNode.toolName }}</span>
            <span class="detail-status" :style="{ color: statusIndicator(selectedNode.status) }">
              {{ selectedNode.status }}
            </span>
          </div>
          <button class="detail-close" @click="closeDetail" title="Esc">&times;</button>
        </div>
        <div class="detail-content">
          <pre>{{ selectedNode.content || "(empty)" }}</pre>
          <div v-if="selectedNode.toolArgs" class="detail-section">
            <div class="detail-section-title">Arguments:</div>
            <pre>{{ JSON.stringify(selectedNode.toolArgs, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.dag-wrapper { display: flex; gap: 12px; width: 100%; }
.dag-container { flex: 1; overflow: auto; max-height: 70vh; min-width: 0; transition: flex 0.2s; }
.dag-container.has-detail { flex: 3; }
.dag-svg { border: 1px solid #d1d9e6; border-radius: 10px; background: #fbfdff; }
.dag-node { cursor: pointer; }
.dag-node .node-bg { opacity: 0.92; transition: opacity 0.15s; }
.dag-node:hover .node-bg { opacity: 1; }

@keyframes pulse {
  0% { opacity: 1; r: 5; }
  100% { opacity: 0; r: 12; }
}
.pulse-ring { animation: pulse 1.2s ease-out infinite; }

.detail-panel {
  flex: 2; max-height: 70vh; display: flex; flex-direction: column;
  background: #fff; border: 1px solid #d1d9e6; border-radius: 10px;
  overflow: hidden; min-width: 280px;
}
.detail-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 14px; border-bottom: 1px solid #e5e7eb; flex-shrink: 0;
}
.detail-title { display: flex; align-items: center; gap: 8px; font-size: 13px; }
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
.slide-enter-active, .slide-leave-active { transition: all 0.2s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(20px); }
</style>
