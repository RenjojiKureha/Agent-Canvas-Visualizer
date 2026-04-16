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
const EDGE_GAP = 8;

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  decisions?: Record<string, { decision: string }>;
}>();

const selectedNodeId = ref<string | null>(null);
const dagContainerRef = ref<HTMLElement | null>(null);
const knownNodeIds = ref(new Set<string>());
const knownEdgeIds = ref(new Set<string>());

// ── Zoom & Pan state ──
const scale = ref(1);
const panX = ref(0);
const panY = ref(0);
const isPanning = ref(false);
const panStart = ref({ x: 0, y: 0 });
const MIN_SCALE = 0.15;
const MAX_SCALE = 3;

const transformStyle = computed(() =>
  `transform: translate(${panX.value}px, ${panY.value}px) scale(${scale.value}); transform-origin: 0 0;`
);

const zoomPercent = computed(() => Math.round(scale.value * 100));

function zoomIn() {
  scale.value = Math.min(MAX_SCALE, scale.value * 1.25);
}

function zoomOut() {
  scale.value = Math.max(MIN_SCALE, scale.value / 1.25);
}

function zoomReset() {
  scale.value = 1;
  panX.value = 0;
  panY.value = 0;
}

function zoomFit() {
  const container = dagContainerRef.value;
  if (!container || layout.value.nodes.length === 0) return;
  const rect = container.getBoundingClientRect();
  const sx = rect.width / layout.value.svgWidth;
  const sy = rect.height / layout.value.svgHeight;
  scale.value = Math.min(sx, sy, 1) * 0.95;
  panX.value = (rect.width - layout.value.svgWidth * scale.value) / 2;
  panY.value = (rect.height - layout.value.svgHeight * scale.value) / 2;
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const container = dagContainerRef.value;
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value * factor));

  // Zoom toward mouse position
  panX.value = mouseX - (mouseX - panX.value) * (newScale / scale.value);
  panY.value = mouseY - (mouseY - panY.value) * (newScale / scale.value);
  scale.value = newScale;
}

function onPointerDown(e: PointerEvent) {
  // Only pan on middle-click or left-click on empty SVG space (not on nodes)
  const target = e.target as Element;
  if (e.button === 1 || (e.button === 0 && target?.closest?.(".dag-svg") && !target?.closest?.(".dag-node"))) {
    isPanning.value = true;
    panStart.value = { x: e.clientX - panX.value, y: e.clientY - panY.value };
    (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
  }
}

function onPointerMove(e: PointerEvent) {
  if (!isPanning.value) return;
  panX.value = e.clientX - panStart.value.x;
  panY.value = e.clientY - panStart.value.y;
}

function onPointerUp() {
  isPanning.value = false;
}

// ── Node detail ──
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

// Auto-scroll (pan) to follow new nodes
const prevNodeCount = ref(0);
watch(
  () => props.nodes.length,
  (count) => {
    if (count > prevNodeCount.value && layout.value.nodes.length > 0) {
      nextTick(() => {
        const lastNode = layout.value.nodes[layout.value.nodes.length - 1];
        const container = dagContainerRef.value;
        if (!lastNode || !container) return;
        const rect = container.getBoundingClientRect();
        const nodeBottom = lastNode.y + lastNode.height;
        const visibleBottom = (-panY.value + rect.height) / scale.value;
        if (nodeBottom > visibleBottom) {
          panY.value = -(nodeBottom * scale.value - rect.height + 40);
        }
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
        x1: isHorizontal ? from.x + from.width + EDGE_GAP : from.x + from.width / 2,
        y1: isHorizontal ? from.y + from.height / 2 : from.y + from.height + EDGE_GAP,
        x2: isHorizontal ? to.x - EDGE_GAP : to.x + to.width / 2,
        y2: isHorizontal ? to.y + to.height / 2 : to.y - EDGE_GAP,
        isNew: !knownEdgeIds.value.has(edgeId),
      };
    })
    .filter((e): e is LayoutEdge => Boolean(e));

  const svgWidth = Math.max(1100, ...nodes.map((nd) => nd.x + nd.width + 80));
  const svgHeight = Math.max(620, ...nodes.map((nd) => nd.y + nd.height + 80));

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
    <!-- Pannable/zoomable viewport -->
    <div
      ref="dagContainerRef"
      class="dag-viewport"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      :class="{ panning: isPanning }"
    >
      <div v-if="props.nodes.length === 0" class="dag-empty">
        <div class="dag-empty-content">
          <div class="dag-empty-icon">&#9697;</div>
          <div class="dag-empty-text">Start an agent run to see the execution graph here.</div>
          <div class="dag-empty-hint">Configure prompt and project path in the sidebar, then click Start Run.</div>
        </div>
      </div>
      <div v-else class="dag-transform" :style="transformStyle">
        <svg :width="layout.svgWidth" :height="layout.svgHeight" class="dag-svg" overflow="visible">
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
            <clipPath v-for="n in layout.nodes" :key="`clip-${n.id}`" :id="`clip-${n.id}`">
              <rect x="0" y="0" rx="10" ry="10" :width="n.width" :height="n.height" />
            </clipPath>
          </defs>

          <!-- Edges -->
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

          <!-- Nodes -->
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
              @click.stop="selectNode(n.id)"
              @animationend="onNodeAnimated(n.id)">

              <rect x="0" y="0" rx="10" ry="10"
                :width="n.width" :height="n.height"
                fill="#ffffff" stroke="#e5e7eb" stroke-width="1"
                class="node-bg" filter="url(#node-shadow)" />

              <rect x="0" y="8" width="4" :height="n.height - 16" rx="2"
                :fill="n.fillColor" />

              <rect x="14" y="8" :width="n.badgeWidth" height="22" rx="11"
                :fill="n.fillColor" />
              <text :x="14 + n.badgeWidth / 2" y="23"
                fill="white" font-size="11" font-weight="600"
                text-anchor="middle">
                {{ n.badgeLabel }}
              </text>

              <text v-if="n.toolName" :x="14 + n.badgeWidth + 8" y="23"
                fill="#1d4ed8" font-size="11" font-weight="600"
                font-family="'Cascadia Code', monospace">
                {{ n.toolName }}
              </text>

              <text :x="n.width - 32" y="23"
                fill="#9ca3af" font-size="11" text-anchor="end">
                {{ n.statusLabel }}
              </text>

              <circle v-if="n.status === 'streaming'"
                :cx="n.width - 16" cy="19" r="7"
                fill="none" :stroke="n.statusColor" stroke-width="1.5"
                class="pulse-ring" />
              <circle :cx="n.width - 16" cy="19" r="4" :fill="n.statusColor" />

              <line x1="14" :y1="HEADER_H - 6" :x2="n.width - 14" :y2="HEADER_H - 6"
                stroke="#f0f0f0" stroke-width="1" />

              <g v-if="props.decisions?.[n.id]">
                <rect :x="n.width - 32 - decisionBadgeWidth(props.decisions[n.id].decision) - 8" y="10" :width="decisionBadgeWidth(props.decisions[n.id].decision)" height="18" rx="9"
                  :fill="decisionColor(props.decisions[n.id].decision)" opacity="0.9" />
                <text :x="n.width - 32 - decisionBadgeWidth(props.decisions[n.id].decision) / 2 - 8" y="22"
                  fill="white" font-size="9" font-weight="600" text-anchor="middle">
                  {{ props.decisions[n.id].decision.toUpperCase() }}
                </text>
              </g>

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

            <rect v-if="selectedNodeId === n.id"
              x="-2" y="-2" rx="12" ry="12"
              :width="n.width + 4" :height="n.height + 4"
              fill="none" stroke="#3b82f6" stroke-width="2" />
          </g>
        </svg>
      </div>
    </div>

    <!-- Zoom controls -->
    <div v-if="props.nodes.length > 0" class="zoom-controls">
      <button @click="zoomIn" title="Zoom in">+</button>
      <div class="zoom-label">{{ zoomPercent }}%</div>
      <button @click="zoomOut" title="Zoom out">&minus;</button>
      <button @click="zoomReset" title="Reset zoom" style="font-size:12px">1:1</button>
      <button @click="zoomFit" title="Fit to view" style="font-size:11px">Fit</button>
    </div>

    <!-- Detail panel -->
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
.dag-wrapper {
  flex: 1;
  display: flex;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.dag-viewport {
  flex: 1;
  overflow: hidden;
  cursor: grab;
  position: relative;
  user-select: none;
  background:
    radial-gradient(circle, #e5e7eb 1px, transparent 1px);
  background-size: 24px 24px;
  background-color: #f8fafc;
}

.dag-viewport.panning {
  cursor: grabbing;
}

.dag-transform {
  will-change: transform;
}

.dag-svg {
  display: block;
}

/* Node card */
.dag-node { cursor: pointer; }
.dag-node .node-bg { transition: filter 0.2s, stroke 0.2s; }
.dag-node:hover .node-bg { filter: url(#node-shadow-hover); stroke: #d1d5db; }

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

@keyframes edge-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dag-edge.entering {
  animation: edge-enter 0.3s ease-out 0.1s both;
}

@keyframes pulse {
  0% { opacity: 1; r: 4; }
  100% { opacity: 0; r: 11; }
}
.pulse-ring { animation: pulse 1.2s ease-out infinite; }

/* Detail panel */
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
.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease, opacity 0.25s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(100%); }

/* Empty state */
.dag-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
}
.dag-empty-content {
  text-align: center;
  color: #9ca3af;
}
.dag-empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.4;
}
.dag-empty-text {
  font-size: 15px;
  margin-bottom: 6px;
}
.dag-empty-hint {
  font-size: 12px;
  opacity: 0.7;
}
</style>
