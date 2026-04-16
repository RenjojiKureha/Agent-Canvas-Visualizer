# Frontend UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 6 categories of frontend UX issues: node content display, edge labels, layout/scrolling, information gaps, interaction quality, and detail panel behavior.

**Architecture:** Incremental improvements to existing Vue 3 SFC components. Changes are scoped to `apps/web/src/` only. No backend or shared package changes needed. Each task produces a working UI state.

**Tech Stack:** Vue 3, SVG, CSS

---

### Task 1: Show toolName and step on node cards

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue:101-111` (roleLabel function)
- Modify: `apps/web/src/components/DagCanvas.vue:189-219` (LayoutNode computation)
- Modify: `apps/web/src/components/DagCanvas.vue:316-331` (node header SVG template)

Currently node cards only show role badge (e.g. "Tool Call") but not the tool name or step number. The toolName is hidden in detail panel only.

- [ ] **Step 1: Add toolName display to node header in template**

In `DagCanvas.vue`, after the status text `<text>` element (line ~330), add a toolName label that shows next to the role badge when the node has a `toolName`. Also show step number in the badge for tool_call/tool_result roles.

Update the badge label computation in the `layout` computed to include toolName:

```typescript
// In the layout computed, when building LayoutNode (around line 191):
const badgeLabel = roleLabel(n.role);
const toolLabel = n.toolName ? ` → ${n.toolName}` : "";
const fullLabel = badgeLabel + toolLabel;
const badgeWidth = fullLabel.length * 7.2 + 20;
```

Update the SVG template badge text (around line 322):
```html
<text :x="14 + n.badgeWidth / 2" y="23"
  fill="white" font-size="11" font-weight="600"
  text-anchor="middle">
  {{ n.badgeLabel }}
</text>
```

Change `n.badgeLabel` to show the full label with toolName included.

But actually, a cleaner approach: keep the role badge short, add toolName as a separate monospace label after the badge.

Replace lines 316-331 with:

```html
<!-- Role badge -->
<rect x="14" y="8" :width="n.badgeWidth" height="22" rx="11"
  :fill="n.fillColor" />
<text :x="14 + n.badgeWidth / 2" y="23"
  fill="white" font-size="11" font-weight="600"
  text-anchor="middle">
  {{ n.badgeLabel }}
</text>

<!-- Tool name (after badge) -->
<text v-if="n.toolName" :x="14 + n.badgeWidth + 8" y="23"
  fill="#1d4ed8" font-size="11" font-weight="600"
  font-family="'Cascadia Code', monospace">
  {{ n.toolName }}
</text>

<!-- Step number (before status dot) -->
<text v-if="n.step" :x="n.width - 50" y="23"
  fill="#9ca3af" font-size="10" text-anchor="end">
  #{{ n.step }}
</text>

<!-- Status text (repositioned) -->
<text :x="n.width - 32" y="23"
  fill="#9ca3af" font-size="11" text-anchor="end">
  {{ n.statusLabel }}
</text>
```

Wait — this needs careful layout. Let me simplify. Keep status dot at right edge, put status text just before it, put step before that, and tool name after badge.

Actually, the cleanest approach is to put the toolName right after the role badge, and move the status label to be right-aligned near the status dot.

- [ ] **Step 2: Add step field to LayoutNode type and computation**

In LayoutNode type (line 5-19), add `step?: number` if not already there. In the `layout` computed (line 189-219), include `step: n.step` in the spread.

The `GraphNode` already has `step?: number` but the reducer doesn't save it from `node_created`. Check: the `node_created` event doesn't include step. The step comes from `loop_step` events. We can get it from the store's `stepInfo.current`. But nodes don't track which step they belong to.

For now, skip step display — it requires backend changes to include step in node_created events. Focus on toolName which is already available.

- [ ] **Step 3: Verify toolName shows on nodes**

Run: `cd /e/Agent-Canvas-Visualizer && npm run -w apps/web dev`

Open browser, start an agent run with a tool-using prompt. Verify:
- tool_call nodes show "Tool Call" badge followed by the tool name (e.g. `read_file`)
- tool_result nodes show "Result" badge (no tool name, which is correct — toolName is only on tool_call)
- Layout doesn't overflow or break

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): show toolName on node cards next to role badge"
```

---

### Task 2: Show edge kind labels on connections

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue:286-292` (edge SVG template)
- Modify: `apps/web/src/components/DagCanvas.vue:222-240` (LayoutEdge computation)

Currently all edges look identical. The `kind` field ("calls", "tool", "plan", "depends") is not displayed.

- [ ] **Step 1: Add edge kind label and color**

Add a helper function for edge styling:

```typescript
function edgeStyle(kind: GraphEdge["kind"]): { color: string; label: string; dash?: string } {
  switch (kind) {
    case "calls": return { color: "#3b82f6", label: "calls" };
    case "tool":  return { color: "#7c3aed", label: "result" };
    case "plan":  return { color: "#059669", label: "plan", dash: "6 3" };
    case "depends": return { color: "#d97706", label: "dep", dash: "4 2" };
    default: return { color: "#94a3b8", label: "" };
  }
}
```

- [ ] **Step 2: Update edge template to use colors and labels**

Replace the edge rendering (lines 287-292):

```html
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
```

Also update the arrow marker to not be hardcoded gray — we can keep a single gray arrow for simplicity since colored paths are sufficient visual differentiation.

- [ ] **Step 3: Verify edge labels are visible**

Run dev server, trigger a run. Check:
- "calls" edges (thinking → tool_call) are blue
- "result" edges (tool_call → tool_result) are purple
- Labels appear at the midpoint of each edge
- Labels don't overlap with nodes

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): color-code edges and show kind labels"
```

---

### Task 3: Improve node content preview and add click hint

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue:29-30` (PREVIEW_LINES, MAX_CHARS_PER_LINE constants)
- Modify: `apps/web/src/components/DagCanvas.vue:193-199` (truncation message)
- Modify: `apps/web/src/components/DagCanvas.vue:343-355` (content lines template)

- [ ] **Step 1: Increase preview limits and improve truncation hint**

Change constants:
```typescript
const PREVIEW_LINES = 8;       // was 6
const MAX_CHARS_PER_LINE = 52;  // was 40
```

Change the truncation message (line 198) from:
```typescript
[...allWrapped.slice(0, PREVIEW_LINES), `... ${totalLines} lines total`]
```
to:
```typescript
[...allWrapped.slice(0, PREVIEW_LINES), `▼ ${totalLines} lines — click to expand`]
```

- [ ] **Step 2: Style the truncation hint line distinctly**

The template already styles the last line of truncated content in italic gray (lines 349-351). Keep that but update font-size to match:

```html
:font-size="n.truncated && idx === n.lines.length - 1 ? '10' : '11.5'"
```

Also add `cursor: pointer` hint text via the node's existing click handler — this already works since the whole node is clickable.

- [ ] **Step 3: Verify improved content display**

Check that nodes now show 8 lines × 52 chars (416 chars visible), and the click-to-expand message is clear.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): increase node preview limits and add click-to-expand hint"
```

---

### Task 4: Fix layout — remove double scrolling, full-height canvas

**Files:**
- Modify: `apps/web/src/styles.css:20-24` (.page)
- Modify: `apps/web/src/components/DagCanvas.vue:394-399` (.dag-wrapper, .dag-container styles)
- Modify: `apps/web/src/App.vue:72-129` (template structure)

The current layout has `.dag-container { max-height: 70vh }` causing a nested scroll context inside the page scroll. Fix: make the page not scroll itself, and let the DAG container fill available space.

- [ ] **Step 1: Update page layout to fill viewport**

In `styles.css`, change `.page`:
```css
.page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 24px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 2: Update DagCanvas wrapper to fill available space**

In `DagCanvas.vue` scoped styles, change:
```css
.dag-container { flex: 1; overflow: auto; min-width: 0; transition: flex 0.2s; }
```

Remove `max-height: 70vh` — the container will now be sized by its parent flex container.

In `App.vue`, make the panel containing DagCanvas grow to fill remaining space:
```html
<section class="panel dag-panel" style="margin-bottom: 12px; flex: 1; min-height: 0; display: flex; flex-direction: column;">
```

And add CSS for `dag-panel` in styles.css:
```css
.dag-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

Actually, this gets complicated with inline styles. Simpler approach: keep the max-height but make it larger and use `calc`:

```css
.dag-container { flex: 1; overflow: auto; max-height: calc(100vh - 300px); min-width: 0; transition: flex 0.2s; }
```

This adapts to viewport height. 300px accounts for header, inputs, meta bar. It's not pixel-perfect but eliminates the worst of the double-scroll issue.

- [ ] **Step 3: Verify single scroll context**

Open the app, start a long run that creates many nodes. Check:
- Only the DAG container scrolls, not the outer page (or vice versa)
- The DAG area uses most of the viewport
- On resize, the DAG area adjusts

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue apps/web/src/styles.css
git commit -m "fix(web): adapt DAG container height to viewport, reduce double scroll"
```

---

### Task 5: Convert detail panel to overlay drawer

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue:367-391` (detail panel template)
- Modify: `apps/web/src/components/DagCanvas.vue:442-474` (detail panel styles)

Currently the detail panel uses `flex: 2` which squeezes the canvas. Convert it to a fixed-position overlay drawer on the right side.

- [ ] **Step 1: Change detail panel to fixed-position overlay**

Remove `has-detail` class logic from `.dag-container`. The canvas should always be full width.

Change the template — move the detail panel outside `.dag-wrapper`:

In template, the current structure is:
```html
<div class="dag-wrapper">
  <div class="dag-container">...</div>
  <transition name="slide">
    <div v-if="selectedNode" class="detail-panel">...</div>
  </transition>
</div>
```

Emit an event so the parent can overlay, OR keep it inside but use `position: fixed`:

```html
<transition name="slide">
  <div v-if="selectedNode" class="detail-panel">
    <!-- same content as before -->
  </div>
</transition>
```

Update styles:
```css
.dag-wrapper { display: flex; gap: 12px; width: 100%; min-width: 0; overflow: hidden; position: relative; }
.dag-container { flex: 1; overflow: auto; max-height: calc(100vh - 300px); min-width: 0; }
/* Remove: .dag-container.has-detail { flex: 3; } */

.detail-panel {
  position: fixed;
  top: 80px;
  right: 24px;
  bottom: 24px;
  width: 440px;
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d1d9e6;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: -4px 0 24px rgba(0,0,0,0.08);
  z-index: 10;
}
```

- [ ] **Step 2: Update transition animation for drawer**

```css
.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease, opacity 0.25s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(100%); }
```

- [ ] **Step 3: Remove has-detail class from dag-container**

In the template, change:
```html
<div ref="dagContainerRef" class="dag-container" :class="{ 'has-detail': selectedNode }">
```
to:
```html
<div ref="dagContainerRef" class="dag-container">
```

- [ ] **Step 4: Add click-outside-to-close behavior**

Add a backdrop click handler. When clicking outside the detail panel (but not on a node), close it. The existing Escape key handler already works.

Actually, this is already handled — clicking a selected node deselects it. The overlay itself doesn't need a backdrop. Keep it simple.

- [ ] **Step 5: Verify drawer behavior**

Check:
- Clicking a node opens the drawer on the right
- Canvas is not squeezed
- Drawer has a shadow and slides in from the right
- Escape closes it
- Clicking the same node closes it

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): convert detail panel to overlay drawer"
```

---

### Task 6: Add node hover tooltip

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue:294-363` (node SVG template)
- Modify: `apps/web/src/components/DagCanvas.vue` (add tooltip state and template)
- Modify: `apps/web/src/components/DagCanvas.vue` (add tooltip styles)

SVG `<title>` elements provide native browser tooltips. This is the simplest approach.

- [ ] **Step 1: Add SVG title element to each node**

Inside the node `<g>` group (after the click handler), add a `<title>` element:

```html
<g v-for="n in layout.nodes" :key="n.id"
  :transform="`translate(${n.x}, ${n.y})`">
  <title>{{ nodeTooltip(n) }}</title>
  <g class="dag-node" ...>
```

Add the tooltip helper:
```typescript
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
```

- [ ] **Step 2: Verify tooltips**

Hover over nodes — a native browser tooltip should appear after a short delay showing role, tool name, status, and content preview.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): add hover tooltips to DAG nodes"
```

---

### Task 7: Display HITL decision history on resolved checkpoints

**Files:**
- Modify: `apps/web/src/stores/agentRun.ts:13` (add resolvedCheckpoints computed)
- Modify: `apps/web/src/components/DagCanvas.vue` (accept resolvedCheckpoints prop, render on nodes)
- Modify: `apps/web/src/App.vue:118` (pass resolvedCheckpoints to DagCanvas)

When a user makes a HITL decision, the checkpoint is resolved but the decision/note is not visible anywhere in the UI.

- [ ] **Step 1: Add resolvedCheckpoints computed to store**

In `agentRun.ts`, add:
```typescript
const resolvedCheckpoints = computed(() => {
  const result: Record<string, { decision: string; nodeId: string }> = {};
  for (const [id, cp] of Object.entries(graph.value.checkpoints)) {
    if (cp.resolved && cp.decision) {
      result[cp.nodeId] = { decision: cp.decision, nodeId: cp.nodeId };
    }
  }
  return result;
});
```

Return it in the store's return object.

- [ ] **Step 2: Pass resolved decisions to DagCanvas**

In `App.vue`, pass the data:
```html
<DagCanvas :nodes="store.nodes" :edges="store.graph.edges" :decisions="store.resolvedCheckpoints" />
```

In `DagCanvas.vue`, accept the new prop:
```typescript
const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  decisions?: Record<string, { decision: string; nodeId: string }>;
}>();
```

- [ ] **Step 3: Render decision badge on HITL nodes**

In the node SVG template, after the status dot, add a small decision badge for resolved HITL nodes:

```html
<!-- Decision badge for resolved HITL nodes -->
<g v-if="props.decisions?.[n.id]">
  <rect :x="n.width - 100" y="8" width="80" height="18" rx="9"
    :fill="props.decisions[n.id].decision === 'approve' ? '#16a34a' :
           props.decisions[n.id].decision === 'reject' ? '#dc2626' : '#2563eb'"
    opacity="0.9" />
  <text :x="n.width - 60" y="20"
    fill="white" font-size="9" font-weight="600" text-anchor="middle">
    {{ props.decisions[n.id].decision.toUpperCase() }}
  </text>
</g>
```

- [ ] **Step 4: Verify decision badges appear**

Start a run, trigger a HITL checkpoint, approve/reject it. Check:
- The HITL node shows a green "APPROVE" or red "REJECT" or blue "CONTINUE"/"REVISE" badge
- The badge is visible but not overwhelming

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/agentRun.ts apps/web/src/components/DagCanvas.vue apps/web/src/App.vue
git commit -m "feat(web): show HITL decision badges on resolved checkpoint nodes"
```

---

### Task 8: Widen layout for large screens

**Files:**
- Modify: `apps/web/src/styles.css:20-24` (.page max-width)
- Modify: `apps/web/src/components/DagCanvas.vue:31` (NODE_WIDTH)
- Modify: `apps/web/src/components/DagCanvas.vue:242` (svgWidth)

- [ ] **Step 1: Remove fixed max-width, use fluid layout**

In `styles.css`, change `.page`:
```css
.page {
  max-width: 1800px;   /* was 1440px */
  margin: 0 auto;
  padding: 24px;
}
```

- [ ] **Step 2: Widen NODE_WIDTH slightly**

In `DagCanvas.vue`:
```typescript
const NODE_WIDTH = 420;  // was 360 — better fits 52 chars per line
```

Update `svgWidth` minimum:
```typescript
const svgWidth = Math.max(1100, ...nodes.map((nd) => nd.x + nd.width + 60));
```

- [ ] **Step 3: Verify layout on various widths**

Check at 1920px wide: nodes have more room, no excessive empty space.
Check at 1440px: still works well.
Check at 1024px: horizontal scroll may be needed for branching nodes, which is acceptable with overflow: auto.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/styles.css apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): widen layout for large screens"
```
