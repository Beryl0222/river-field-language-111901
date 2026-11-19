// 分岸有向河网。
// reaches 的 from→to 是水文方向；人员步行可顺可逆，所以“走得通”用无向邻接判断，
// 但每条边仍携带 reach 身份与岸别——空间上靠近但不连通的岸段不会被补成走过。

export function buildGraph(reaches) {
  const nodes = new Set();
  const undirected = new Map();
  const directedOut = new Map();
  const edgeByKey = new Map();
  const reachById = new Map();
  const teamReaches = new Map();
  const teamShore = new Map();
  const shoreReaches = new Map();

  const addAdj = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };

  for (const reach of reaches) {
    nodes.add(reach.from);
    nodes.add(reach.to);
    addAdj(undirected, reach.from, { node: reach.to, reach: reach.id });
    addAdj(undirected, reach.to, { node: reach.from, reach: reach.id });
    addAdj(directedOut, reach.from, { node: reach.to, reach: reach.id });
    edgeByKey.set(`${reach.from}->${reach.to}`, reach.id);
    edgeByKey.set(`${reach.to}->${reach.from}`, reach.id); // 反向步行仍落在同一条岸段
    reachById.set(reach.id, reach);
    if (!teamReaches.has(reach.team)) teamReaches.set(reach.team, []);
    teamReaches.get(reach.team).push(reach.id);
    if (!teamShore.has(reach.team)) teamShore.set(reach.team, new Set());
    teamShore.get(reach.team).add(reach.shore);
    if (!shoreReaches.has(reach.shore)) shoreReaches.set(reach.shore, []);
    shoreReaches.get(reach.shore).push(reach.id);
  }

  return {
    nodes,
    undirected,
    directedOut,
    edgeByKey,
    reachById,
    teamReaches,
    teamShore,
    shoreReaches,
  };
}

/** 枚举两节点间所有不重复岸段的简单步行路径（带步数上限，防止大河网卡死）。 */
export function findWalkPaths(graph, start, goal, maxSteps = 20) {
  if (!graph.nodes.has(start) || !graph.nodes.has(goal)) return [];
  if (start === goal) return [{ nodes: [start], reachIds: [] }];
  const results = [];
  const walk = (node, seenReaches, pathNodes, pathReaches, depth) => {
    if (depth > maxSteps) return;
    for (const { node: next, reach } of graph.undirected.get(node) ?? []) {
      if (seenReaches.has(reach)) continue;
      const nextSeen = new Set(seenReaches).add(reach);
      const nextNodes = [...pathNodes, next];
      const nextReaches = [...pathReaches, reach];
      if (next === goal) {
        results.push({ nodes: nextNodes, reachIds: nextReaches });
      } else {
        walk(next, nextSeen, nextNodes, nextReaches, depth + 1);
      }
    }
  };
  walk(start, new Set(), [start], [], 0);
  return results;
}

/** 单条 reach 的两个端点。 */
export function reachEndpoints(graph, reachId) {
  const r = graph.reachById.get(reachId);
  return r ? [r.from, r.to] : null;
}

/** 与某节点相连、且属于指定岸别的岸段。 */
export function reachesAtNode(graph, node, shore = null) {
  const out = [];
  for (const { reach } of graph.undirected.get(node) ?? []) {
    const r = graph.reachById.get(reach);
    if (!shore || r.shore === shore) out.push(reach);
  }
  return [...new Set(out)];
}

/** 支沟节点：优先取 reach 上的 branch 显式标记，否则用“支沟”俗名地标兜底。 */
export function branchNodes(reaches, landmarks) {
  const marked = new Set();
  for (const r of reaches) {
    if (r.branch) {
      marked.add(r.from);
      marked.add(r.to);
    }
  }
  for (const lm of landmarks) {
    if (lm.aliases.some((a) => a.includes('支沟'))) marked.add(lm.node);
  }
  return marked;
}

/**
 * 支沟岸段：显式 branch 标记，或任一端点落在支沟节点集合内。
 * 支沟节点往往只标到汇口/沟口一个点，接在该点上的沟内岸段由此识别。
 */
export function markBranchReaches(reaches, landmarks) {
  const bn = branchNodes(reaches, landmarks);
  for (const r of reaches) {
    if (r.branch || bn.has(r.from) || bn.has(r.to)) r.branch = true;
  }
  return bn;
}
