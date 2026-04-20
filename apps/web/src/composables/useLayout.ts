import { computed, type ComputedRef, type Ref } from "vue";
import type { GraphNode, GraphEdge } from "@acv/shared";
import {
  BRANCH_GAP_X,
  BOTTOM_PAD,
  EDGE_GAP,
  HEADER_H,
  MAX_CHARS_PER_LINE,
  NODE_GAP_Y,
  NODE_WIDTH,
  PREVIEW_LINES,
  type LayoutEdge,
  type LayoutNode,
  nodeHeight,
  roleColor,
  roleLabel,
  statusIndicator,
  statusText,
  wrapLine,
} from "./dagLayout";

interface UseLayoutResult {
  layout: ComputedRef<{
    nodes: LayoutNode[];
    edges: LayoutEdge[];
    svgWidth: number;
    svgHeight: number;
  }>;
}

export function useLayout(
  nodes: Ref<GraphNode[]> | ComputedRef<GraphNode[]>,
  edges: Ref<GraphEdge[]> | ComputedRef<GraphEdge[]>,
  knownNodeIds: Ref<Set<string>>,
  knownEdgeIds: Ref<Set<string>>,
): UseLayoutResult {
  const layout = computed(() => {
    const mainRoles = new Set(["thinking", "answer", "error"]);
    const mainCol: GraphNode[] = [];
    const branches = new Map<string, GraphNode[]>();
    const nodeIndex = new Map<string, GraphNode>();

    for (const n of nodes.value) {
      nodeIndex.set(n.id, n);
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
    const mainX = 32;

    function layoutSubtree(nodeId: string, x: number, y: number): number {
      const node = nodeIndex.get(nodeId);
      if (!node) return 0;
      posMap.set(nodeId, { x, y });
      const selfH = nodeHeight(node);

      const children = branches.get(nodeId) || [];
      if (children.length === 0) return selfH;

      let stackedH = 0;
      for (const child of children) {
        const childX = x + NODE_WIDTH + BRANCH_GAP_X;
        const childY = y + stackedH;
        const subH = layoutSubtree(child.id, childX, childY);
        stackedH += subH + NODE_GAP_Y;
      }
      stackedH -= NODE_GAP_Y;

      return Math.max(selfH, stackedH);
    }

    let cursorY = 24;
    for (const n of mainCol) {
      posMap.set(n.id, { x: mainX, y: cursorY });
      const h = nodeHeight(n);

      const branchNodes = branches.get(n.id) || [];
      let branchStackedH = 0;
      for (const bn of branchNodes) {
        const bx = mainX + NODE_WIDTH + BRANCH_GAP_X;
        const by = cursorY + branchStackedH;
        const subH = layoutSubtree(bn.id, bx, by);
        branchStackedH += subH + NODE_GAP_Y;
      }
      branchStackedH = Math.max(0, branchStackedH - NODE_GAP_Y);

      cursorY += Math.max(h, branchStackedH) + NODE_GAP_Y;
    }

    const layoutNodes: LayoutNode[] = nodes.value.map((n) => {
      const pos = posMap.get(n.id) || { x: mainX, y: 24 };
      const badgeLabel = roleLabel(n.role);
      const badgeWidth = badgeLabel.length * 7.2 + 20;
      const rawLines = (n.content || "").split(/\r?\n/);
      const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
      const totalLines = allWrapped.length;
      const truncated = allWrapped.length > PREVIEW_LINES;
      const lines = truncated
        ? [...allWrapped.slice(0, PREVIEW_LINES), `\u25BC ${totalLines} lines — click to expand`]
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

    const nodePos = new Map(layoutNodes.map((nd) => [nd.id, nd]));
    const layoutEdges: LayoutEdge[] = edges.value
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

    const svgWidth = Math.max(1100, ...layoutNodes.map((nd) => nd.x + nd.width + 80));
    const svgHeight = Math.max(620, ...layoutNodes.map((nd) => nd.y + nd.height + 80));

    return { nodes: layoutNodes, edges: layoutEdges, svgWidth, svgHeight };
  });

  return { layout };
}
