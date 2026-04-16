<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";

type LayoutNode = GraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  badgeLabel: string;
  badgeWidth: number;
  statusLabel: string;
  lines: string[];
  truncated: boolean;
  totalLines: number;
  fillColor: string;
  statusColor: string;
  isNew: boolean;
};

type LayoutEdge = GraphEdge & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isNew: boolean;
};

const PREVIEW_LINES = 8;
const MAX_CHARS_PER_LINE = 52;
const NODE_WIDTH = 420;
const NODE_GAP_Y = 32;
const BRANCH_GAP_X = 72;
const HEADER_H = 42;
const BOTTOM_PAD = 16;
const EDGE_GAP = 8; // gap between arrow tip and node boundary

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  decisions?: Record<string, { decision: string }>;
}>();

const selectedNodeId = ref<string | null>(null);
const dagContainerRef = ref<HTMLElement | null>(null);
const knownNodeIds = ref(new Set<string>());
const knownEdgeIds = ref(new Set<string>());

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

function onNodeAnimated(id: string) {
  knownNodeIds.value.add(id);
}
function onEdgeAnimated(id: string) {
  knownEdgeIds.value.add(id);
}

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

function statusText(status: GraphNode["status"]): string {
  switch (status) {
    case "streaming": return "streaming...";
    case "waiting_human": return "waiting";
    default: return status;
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

function nodeHeight(n: GraphNode): number {
  const rawLines = (n.content || "").split(/\r?\n/);
  const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
  const lineCount = Math.min(allWrapped.length, PREVIEW_LINES + 1);
  return HEADER_H + Math.max(lineCount, 1) * 16 + BOTTOM_PAD;
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
    const badgeLabel = roleLabel(n.role);
    const badgeWidth = badgeLabel.length * 7.2 + 20;
    const rawLines = (n.content || "").split(/\r?\n/);
    const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
    const totalLines = allWrapped.length;
    const truncated = allWrapped.length > PREVIEW_LINES;
    const lines = truncated
      ? [...allWrapped.slice(0, PREVIEW_LINES), `▼ ${totalLines} lines — click to expand`]
      : allWrapped;

    const height = HEADER_H + Math.max(lines.length, 1) * 16 + BOTTOM_PAD;

    return {
      ...n,
      x: pos.x,
      y: pos.y,
      width: NODE_WIDTH,
      height,
      badgeLabel,
      badgeWidth,
      statusLabel: statusText(n.status),
      lines,
      truncated,
      totalLines,
      fillColor: roleColor(n.role),
      statusColor: statusIndicator(n.status),
      isNew: !knownNodeIds.value.has(n.id),
    };
  });

  const nodePos = new Map(nodes.map((nd) => [nd.id, nd]));
  const edges: LayoutEdge[] = props.edges
    .map((e) => {
      const from = nodePos.get(e.from);
      const to = nodePos.get(e.to);
      if (!from || !to) return null;
      const isHorizontal = Math.abs(from.x - to.x) > NODE_WIDTH / 2;
      const edgeId = `${e.from}->${e.to}:${e.kind}`;
      return {
        ...e,
        id: edgeId,
        // Offset endpoints away from node boundaries so arrows stay visible
        x1: isHorizontal ? from.x + from.width + EDGE_GAP : from.x + from.width / 2,
        y1: isHorizontal ? from.y + from.height / 2 : from.y + from.height + EDGE_GAP,
        x2: isHorizontal ? to.x - EDGE_GAP : to.x + to.width / 2,
        y2: isHorizontal ? to.y + to.height / 2 : to.y - EDGE_GAP,
        isNew: !knownEdgeIds.value.has(edgeId),
      };
    })
    .filter((e): e is LayoutEdge => Boolean(e));

  const svgWidth = Math.max(1100, ...nodes.map((nd) => nd.x + nd.width + 60));
  const svgHeight = Math.max(620, ...nodes.map((nd) => nd.y + nd.height + 60));

  return { nodes, edges, svgWidth, svgHeight };
});

function edgeStyle(kind: GraphEdge["kind"]): { color: string; label: string; dash?: string } {
  switch (kind) {
    case "calls": return { color: "#3b82f6", label: "calls" };
    case "tool":  return { color: "#7c3aed", label: "result" };
    case "plan":  return { color: "#059669", label: "plan", dash: "6 3" };
    case "depends": return { color: "#d97706", label: "dep", dash: "4 2" };
    default: return { color: "#94a3b8", label: "" };
  }
}

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

function nodeTooltip(n: LayoutNode): string {
  const parts = [roleLabel(n.role)];
  if (n.toolName) parts.push(`Tool: ${n.toolName}`);
  parts.push(`Status: ${n.status}`);
  if (n.content) {
    const preview = n.content.slice(0, 200);
    parts.push(`---\n${preview}${n.content.length > 200 ? "..." : ""}`);
  }
  return parts.join("\n");
}

function decisionColor(decision: string): string {
  switch (decision) {
    case "approve": return "#16a34a";
    case "reject": return "#dc2626";
    case "continue": return "#2563eb";
    case "revise": return "#d97706";
    case "finish": return "#374151";
    case "retry": return "#059669";
    case "abort": return "#dc2626";
    default: return "#6b7280";
  }
}

function decisionBadgeWidth(decision: string): number {
  return decision.length * 6.5 + 16;
}
</script>

<template>
  <div class="dag-wrapper">
    <div ref="dagContainerRef" class="dag-container">
      <div v-if="props.nodes.length === 0" class="dag-empty">
        Start an agent run to see the execution graph here.
      </div>
      <svg v-else :width="layout.svgWidth" :height="layout.svgHeight" class="dag-svg">
        <defs>
          <filter id="node-shadow" x="-6%" y="-6%" width="112%" height="120%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.07" />
          </filter>
          <filter id="node-shadow-hover" x="-6%" y="-6%" width="112%" height="120%">
            <feDropShadow dx="0" dy="4" stdDeviation="8" flood-opacity="0.12" />
          </filter>
          <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3 L 0 6 z" fill="#94a3b8" />
          </marker>
          <!-- One clipPath per node to prevent text overflow -->
          <clipPath v-for="n in layout.nodes" :key="`clip-${n.id}`" :id="`clip-${n.id}`">
            <rect x="0" y="0" rx="10" ry="10" :width="n.width" :height="n.height" />
          </clipPath>
        </defs>

        <!-- Edges (rendered first, below nodes) -->
        <g v-for="e in layout.edges" :key="e.id"
          class="dag-edge" :class="{ entering: e.isNew }"
          @animationend="onEdgeAnimated(e.id)">
          <path :d="edgePath(e)"
            fill="none" :stroke="edgeStyle(e.kind).color" stroke-width="1.5"
            :stroke-dasharray="edgeStyle(e.kind).dash || 'none'"
            marker-end="url(#arrow)" />
          <text
            :x="(e.x1 + e.x2) / 2"
            :y="(e.y1 + e.y2) / 2 - 6"
            :fill="edgeStyle(e.kind).color"
            font-size="9" font-weight="600" text-anchor="middle"
            opacity="0.7">
            {{ edgeStyle(e.kind).label }}
          </text>
        </g>

        <!-- Nodes: outer <g> handles position, inner <g> handles animation -->
        <g v-for="n in layout.nodes" :key="n.id"
          :transform="`translate(${n.x}, ${n.y})`">
          <title>{{ nodeTooltip(n) }}</title>
          <g class="dag-node"
            :class="{
              selected: selectedNodeId === n.id,
              streaming: n.status === 'streaming',
              entering: n.isNew,
            }"
            :clip-path="`url(#clip-${n.id})`"
            @click="selectNode(n.id)"
            @animationend="onNodeAnimated(n.id)">

            <!-- Card background with shadow -->
            <rect x="0" y="0" rx="10" ry="10"
              :width="n.width" :height="n.height"
              fill="#ffffff" stroke="#e5e7eb" stroke-width="1"
              class="node-bg" filter="url(#node-shadow)" />

            <!-- Left accent stripe -->
            <rect x="0" y="8" width="4" :height="n.height - 16" rx="2"
              :fill="n.fillColor" />

            <!-- Role badge -->
            <rect x="14" y="8" :width="n.badgeWidth" height="22" rx="11"
              :fill="n.fillColor" />
            <text :x="14 + n.badgeWidth / 2" y="23"
              fill="white" font-size="11" font-weight="600"
              text-anchor="middle">
              {{ n.badgeLabel }}
            </text>

            <!-- Tool name (shown after badge for tool_call nodes) -->
            <text v-if="n.toolName" :x="14 + n.badgeWidth + 8" y="23"
              fill="#1d4ed8" font-size="11" font-weight="600"
              font-family="'Cascadia Code', monospace">
              {{ n.toolName }}
            </text>

            <!-- Status text (right-aligned near status dot) -->
            <text :x="n.width - 32" y="23"
              fill="#9ca3af" font-size="11" text-anchor="end">
              {{ n.statusLabel }}
            </text>

            <!-- Status dot -->
            <circle v-if="n.status === 'streaming'"
              :cx="n.width - 16" cy="19" r="7"
              fill="none" :stroke="n.statusColor" stroke-width="1.5"
              class="pulse-ring" />
            <circle :cx="n.width - 16" cy="19" r="4" :fill="n.statusColor" />

            <!-- Divider -->
            <line x1="14" :y1="HEADER_H - 6" :x2="n.width - 14" :y2="HEADER_H - 6"
              stroke="#f0f0f0" stroke-width="1" />

            <!-- HITL decision badge (for resolved checkpoints) -->
            <g v-if="props.decisions?.[n.id]">
              <rect :x="n.width - 32 - decisionBadgeWidth(props.decisions[n.id].decision) - 8" y="10" :width="decisionBadgeWidth(props.decisions[n.id].decision)" height="18" rx="9"
                :fill="decisionColor(props.decisions[n.id].decision)" opacity="0.9" />
              <text :x="n.width - 32 - decisionBadgeWidth(props.decisions[n.id].decision) / 2 - 8" y="22"
                fill="white" font-size="9" font-weight="600" text-anchor="middle">
                {{ props.decisions[n.id].decision.toUpperCase() }}
              </text>
            </g>

            <!-- Content lines -->
            <text
              v-for="(line, idx) in n.lines"
              :key="`${n.id}-${idx}`"
              x="16"
              :y="HEADER_H + 8 + idx * 16"
              :fill="n.truncated && idx === n.lines.length - 1 ? '#9ca3af' : '#374151'"
              :font-size="n.truncated && idx === n.lines.length - 1 ? '10.5' : '11.5'"
              :font-style="n.truncated && idx === n.lines.length - 1 ? 'italic' : 'normal'"
              font-family="'Cascadia Code', 'Fira Code', 'Consolas', monospace"
            >
              {{ line }}
            </text>
          </g>

          <!-- Selection highlight (outside clip so border is visible) -->
          <rect v-if="selectedNodeId === n.id"
            x="-2" y="-2" rx="12" ry="12"
            :width="n.width + 4" :height="n.height + 4"
            fill="none" stroke="#3b82f6" stroke-width="2" />
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
/* Fix 3: min-width:0 + overflow:hidden prevents flex child from pushing wrapper wider */
.dag-wrapper { display: block; width: 100%; min-width: 0; overflow: hidden; position: relative; }
.dag-container { overflow: auto; max-height: calc(100vh - 300px); min-width: 0; }
.dag-svg { border: 1px solid #e5e7eb; border-radius: 10px; background: #f8fafc; }

/* Node card */
.dag-node { cursor: pointer; }
.dag-node .node-bg { transition: filter 0.2s, stroke 0.2s; }
.dag-node:hover .node-bg { filter: url(#node-shadow-hover); stroke: #d1d5db; }

/*
 * Fix 1: Animation is on the INNER <g> (no SVG transform attribute),
 * so CSS transform doesn't conflict with the outer <g>'s SVG translate.
 */
@keyframes node-enter {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.dag-node.entering {
  animation: node-enter 0.35s ease-out both;
}

/* Edge entrance animation */
@keyframes edge-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dag-edge.entering {
  animation: edge-enter 0.3s ease-out 0.1s both;
}

/* Streaming pulse ring */
@keyframes pulse {
  0% { opacity: 1; r: 4; }
  100% { opacity: 0; r: 11; }
}
.pulse-ring { animation: pulse 1.2s ease-out infinite; }

/* Detail panel — fixed overlay drawer */
.detail-panel {
  position: fixed; top: 80px; right: 24px; bottom: 24px; width: 440px;
  max-width: calc(100vw - 48px);
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid #d1d9e6; border-radius: 10px;
  overflow: hidden; box-shadow: -4px 0 24px rgba(0,0,0,0.08); z-index: 10;
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
.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease, opacity 0.25s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(100%); }
.dag-empty {
  display: flex; align-items: center; justify-content: center;
  min-height: 200px; color: #9ca3af; font-size: 14px;
  border: 1px dashed #d1d9e6; border-radius: 10px; background: #f8fafc;
}
</style>
