<script setup lang="ts">
import type { LayoutNode } from "../composables/dagLayout";
import { HEADER_H, decisionColor, decisionBadgeWidth, roleLabel } from "../composables/dagLayout";

const props = defineProps<{
  node: LayoutNode;
  selected: boolean;
  decision?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  animated: [id: string];
}>();

function tooltipText(n: LayoutNode): string {
  const parts = [roleLabel(n.role)];
  if (n.toolName) parts.push(`Tool: ${n.toolName}`);
  parts.push(`Status: ${n.status}`);
  if (n.content) {
    const preview = n.content.slice(0, 200);
    parts.push(`---\n${preview}${n.content.length > 200 ? "..." : ""}`);
  }
  return parts.join("\n");
}
</script>

<template>
  <g :transform="`translate(${props.node.x}, ${props.node.y})`">
    <title>{{ tooltipText(props.node) }}</title>
    <g
      class="dag-node"
      :class="{
        selected: props.selected,
        streaming: props.node.status === 'streaming',
        entering: props.node.isNew,
      }"
      :clip-path="`url(#clip-${props.node.id})`"
      @click.stop="emit('select', props.node.id)"
      @animationend="emit('animated', props.node.id)"
    >
      <rect x="0" y="0" rx="10" ry="10"
        :width="props.node.width" :height="props.node.height"
        fill="#ffffff" stroke="#e5e7eb" stroke-width="1"
        class="node-bg" filter="url(#node-shadow)" />

      <rect x="0" y="8" width="4" :height="props.node.height - 16" rx="2" :fill="props.node.fillColor" />

      <rect x="14" y="8" :width="props.node.badgeWidth" height="22" rx="11" :fill="props.node.fillColor" />
      <text :x="14 + props.node.badgeWidth / 2" y="23"
        fill="white" font-size="11" font-weight="600" text-anchor="middle">
        {{ props.node.badgeLabel }}
      </text>

      <text v-if="props.node.toolName" :x="14 + props.node.badgeWidth + 8" y="23"
        fill="#1d4ed8" font-size="11" font-weight="600"
        font-family="'Cascadia Code', monospace">
        {{ props.node.toolName }}
      </text>

      <text :x="props.node.width - 32" y="23"
        fill="#9ca3af" font-size="11" text-anchor="end">
        {{ props.node.statusLabel }}
      </text>

      <circle v-if="props.node.status === 'streaming'"
        :cx="props.node.width - 16" cy="19" r="7"
        fill="none" :stroke="props.node.statusColor" stroke-width="1.5" class="pulse-ring" />
      <circle :cx="props.node.width - 16" cy="19" r="4" :fill="props.node.statusColor" />

      <line x1="14" :y1="HEADER_H - 6" :x2="props.node.width - 14" :y2="HEADER_H - 6"
        stroke="#f0f0f0" stroke-width="1" />

      <g v-if="props.decision">
        <rect
          :x="props.node.width - 32 - decisionBadgeWidth(props.decision) - 8"
          y="10"
          :width="decisionBadgeWidth(props.decision)"
          height="18"
          rx="9"
          :fill="decisionColor(props.decision)"
          opacity="0.9"
        />
        <text
          :x="props.node.width - 32 - decisionBadgeWidth(props.decision) / 2 - 8"
          y="22"
          fill="white" font-size="9" font-weight="600" text-anchor="middle"
        >
          {{ props.decision.toUpperCase() }}
        </text>
      </g>

      <text
        v-for="(line, idx) in props.node.lines"
        :key="`${props.node.id}-${idx}`"
        x="16"
        :y="HEADER_H + 8 + idx * 16"
        :fill="props.node.truncated && idx === props.node.lines.length - 1 ? '#9ca3af' : '#374151'"
        :font-size="props.node.truncated && idx === props.node.lines.length - 1 ? '10.5' : '11.5'"
        :font-style="props.node.truncated && idx === props.node.lines.length - 1 ? 'italic' : 'normal'"
        font-family="'Cascadia Code', 'Fira Code', 'Consolas', monospace"
      >
        {{ line }}
      </text>
    </g>

    <rect v-if="props.selected"
      x="-2" y="-2" rx="12" ry="12"
      :width="props.node.width + 4" :height="props.node.height + 4"
      fill="none" stroke="#3b82f6" stroke-width="2" />
  </g>
</template>

<style scoped>
.dag-node { cursor: pointer; }
.dag-node .node-bg { transition: filter 0.2s, stroke 0.2s; }
.dag-node:hover .node-bg { stroke: #d1d5db; }

@keyframes node-enter {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.dag-node.entering {
  animation: node-enter 0.35s ease-out both;
}

@keyframes pulse {
  0% { opacity: 1; r: 4; }
  100% { opacity: 0; r: 11; }
}
.pulse-ring { animation: pulse 1.2s ease-out infinite; }
</style>
