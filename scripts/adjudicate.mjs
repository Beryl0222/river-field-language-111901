// 判定层：把证据原子放到有向河网上推断每条岸段的状态，并生成需人工核对的问题。
// 原则：证据不足就保留候选与冲突原句，绝不挑一个“看起来最近”的解释把空白抹掉。

import { buildGraph, findWalkPaths, reachesAtNode, markBranchReaches } from './graph.mjs';
import { parseAll, applyClarifications, effectiveNodes } from './parser.mjs';

const WALK_ACTIONS = new Set(['pass', 'walk', 'enter']);
// cross（过桥/到对岸）只证明人到了该节点，不自动推出一路上走过哪些岸段；
// “看到对岸”在 parser 里归为 remote，与“走到对岸(cross)”严格区分。

function makeQuestioner() {
  const questions = [];
  return {
    questions,
    ask(q) {
      const id = `Q${questions.length + 1}`;
      const question = { id, ...q };
      questions.push(question);
      return id;
    },
  };
}

function recordsFromTasks(recheckTasks) {
  const records = [];
  const taskIndex = new Map();
  for (const task of recheckTasks ?? []) {
    taskIndex.set(task.id, { ...task });
    if (task.status === 'returned' && task.report) {
      records.push({
        id: task.id,
        team: task.team,
        type: 'recheck',
        taskId: task.id,
        sentAt: task.reportedAt ?? task.sentAt,
        text: task.report,
      });
    }
  }
  return { records, taskIndex };
}

/**
 * 主入口。
 * @returns {{reachStates, questions, tasks, graph, parsedRecords, patrol}}
 */
export function adjudicate(data) {
  // 不修改调用方资料：深拷贝 reaches 后再做支沟标记
  const reaches = structuredClone(data.reaches);
  const graph = buildGraph(reaches);
  const aliasIndex = buildAliasIndexLocal(data.landmarks);
  const onBranchNodes = markBranchReaches(reaches, data.landmarks);
  const teamShore = new Map([...graph.teamShore].map(([k, v]) => [k, [...v]]));
  const ctx = { aliasIndex, flowNotes: data.flowNotes ?? [], teamShore, onBranchNodes };

  const { records: taskRecords, taskIndex } = recordsFromTasks(data.recheckTasks);
  const allRecords = [...(data.handovers ?? []), ...taskRecords];
  const parsedRecords = parseAll(allRecords, ctx);

  const { ask, questions } = makeQuestioner();
  const evidenceByReach = new Map(data.reaches.map((r) => [r.id, []]));
  const candidateQuestionsByReach = new Map(data.reaches.map((r) => [r.id, []]));
  const addEvidence = (reachId, ev) => evidenceByReach.get(reachId)?.push(ev);
  const linkQuestion = (reachId, qId) => {
    if (reachId && candidateQuestionsByReach.has(reachId)) candidateQuestionsByReach.get(reachId).push(qId);
  };

  // 每个班组维护当前位置锚点；歧义未消时 certain=false，只能用来提问，不能用来定覆盖。
  const anchors = new Map();
  const lastResolvedMention = new Map(); // team -> mention（供“过桥”这类省略句回指）

  for (const rec of parsedRecords) {
    let anchor = anchors.get(rec.team) ?? null;
    // 班组可进入节点：其负责岸段的规定入口，去掉当班封闭入口（桥/闸/封闭栈道限制）
    const blocked = new Set(data.patrol.blockedEntries ?? []);
    const entryNodes = [...new Set(
      (graph.teamReaches.get(rec.team) ?? [])
        .map((rid) => graph.reachById.get(rid).entry)
        .filter((n) => !blocked.has(n)),
    )];

    for (const atom of rec.atoms) {
      // 纯澄清句只负责给历史地标去歧义，不产生任何巡查证据
      if (atom.clarificationOnly) continue;
      // 小句只有“过桥/没走到闸”这类省略时，回指本班最近被澄清或唯一落图的地标；
      // 回指结果写回 mentions，使 cross 与同句 miss 都能看到同一落点。
      if (atom.mentions.length === 0) {
        const back = lastResolvedMention.get(rec.team);
        if (back && atom.actions.some((a) => ['cross', 'miss'].includes(a))) {
          atom.mentions.push({ raw: back.raw, nodes: back.nodes, resolvedNode: back.resolvedNode, inferred: true, index: -1 });
        }
      }
      const mentions = atom.mentions.map((m) => ({ ...m, nodes: effectiveNodes(m), inferred: Boolean(m.inferred) }));
      for (const m of atom.mentions) {
        if (m.resolvedNode || m.nodes.length === 1) lastResolvedMention.set(rec.team, m);
      }

      const walkActions = atom.actions.filter((a) => WALK_ACTIONS.has(a));
      const isCross = atom.actions.includes('cross');
      const hasQualifying = walkActions.length > 0 || isCross;
      const isRemote = atom.actions.includes('remote');
      const isMiss = atom.actions.includes('miss');
      const isReturn = atom.actions.includes('return');

      // 纯粹的原路退回不产生新证据；但与 walk 等动作同句出现时（走到X才回），
      // 去程证据照常记录，退回只表示之后不前进，所以不能整句跳过。
      if (isReturn && !hasQualifying && !isRemote && !isMiss) {
        continue;
      }

      const targets = [...new Set(mentions.flatMap((m) => m.nodes))];

      // cross（过桥/走到对岸）优先处理：只确认人到了目标节点并记 presence，绝不沿路径补覆盖。
      // 落点有歧义时连 presence 也不能记，必须提问——“看到对岸”是 remote，与此严格区分。
      // 注意：cross 不中断同句的 miss/remote 判定（“过桥后没走到闸”要同时留下漏查问题）。
      if (isCross) {
        if (targets.length === 1) {
          for (const rid of reachesAtNode(graph, targets[0])) {
            addEvidence(rid, {
              kind: 'presence',
              action: 'cross',
              recordId: rec.recordId,
              clause: atom.clause,
              route: `节点 ${targets[0]} 现场到场（过桥/到对岸），不等同于走完相邻岸段`,
              taskId: atom.taskId ?? null,
            });
          }
          anchor = { certain: true, node: targets[0] };
        } else {
          const qId = ask({
            kind: 'ambiguous-cross',
            recordId: rec.recordId,
            clause: atom.clause,
            landmark: mentions.map((m) => `${m.raw}→[${m.nodes.join('/')}]`).join('；'),
            detail: '过桥/到对岸的落点有多个候选，节点到场证据也不能记，待核对',
          });
          for (const rid of [...new Set(targets.flatMap((n) => reachesAtNode(graph, n)))]) linkQuestion(rid, qId);
          anchor = { certain: false, questionId: qId };
        }
      }

      // 只有真正含行走类动作、且不含 cross 的小句才推断路径；cross 的来路须由独立行走小句证明
      if (walkActions.length > 0 && !isCross) {
        if (targets.length === 0) {
          const qId = ask({
            kind: 'unmapped-qualifying',
            recordId: rec.recordId,
            clause: atom.clause,
            unknownTerms: atom.unknownTerms,
            detail: '动作声称实地到达，但小句里没有可落到河网节点的地标，无法推断岸段',
          });
          anchor = { certain: false, questionId: qId };
          continue;
        }

        const starts = anchor?.certain ? [anchor.node] : entryNodes;
        const routeAlternatives = new Map(); // key: 排序后的岸段集合
        for (const target of targets) {
          for (const start of starts) {
            if (start === target) continue; // 人已在该点：零长度路径不构成走过的岸段
            for (const path of findWalkPaths(graph, start, target)) {
              if (path.reachIds.length === 0) continue;
              const key = [...path.reachIds].sort().join('|');
              if (!routeAlternatives.has(key)) {
                routeAlternatives.set(key, { reachIds: path.reachIds, nodes: path.nodes, start, target });
              }
            }
          }
        }
        let alternatives = [...routeAlternatives.values()];

        // 地标俗名携带沟系语义时（支沟桥/支沟…，或经澄清指向支沟节点的别名），
        // 用它筛掉绕主河的走法：走到支沟桥默认沿支沟，绕主河再到同一节点不应作为等价候选。
        const aliasOf = (node) =>
          data.landmarks.find((lm) => lm.node === node)?.aliases ?? [];
        const branchNamed = mentions.some((m) =>
          m.nodes.every((n) => onBranchNodes.has(n)) &&
          (m.raw.includes('支沟') || m.nodes.every((n) => aliasOf(n).some((a) => a.includes('支沟')))),
        );
        if (branchNamed && alternatives.length > 1) {
          const narrowed = alternatives.filter((alt) =>
            alt.reachIds.every((rid) => graph.reachById.get(rid).branch));
          if (narrowed.length >= 1) alternatives = narrowed;
        }

        // 班组尚无确定位置锚点时，首个被唯一落图的地标就是锚点本身：
        // 只记“到过该节点”的 presence 与锚点，不反向猜从哪个入口走来，避免入口多义拖垮后续推断。
        if (!(anchor?.certain) && targets.length === 1 && alternatives.length > 1) {
          const target = targets[0];
          for (const rid of reachesAtNode(graph, target)) {
            addEvidence(rid, {
              kind: 'presence',
              action: walkActions.join('+'),
              recordId: rec.recordId,
              clause: atom.clause,
              route: `节点 ${target} 首次落锚（${walkActions.join('+')}），到点前的来路未在叙述中给出`,
              taskId: atom.taskId ?? null,
            });
          }
          anchor = { certain: true, node: target };
          alternatives = [];
        }

        if (alternatives.length === 0) {
          // 人已在目标节点：行走动作本身不新增覆盖，锚点保持即可
          anchor = { certain: true, node: targets[0] };
        } else if (alternatives.length === 1) {
          const route = alternatives[0];
          for (const rid of route.reachIds) {
            addEvidence(rid, {
              kind: 'covered',
              action: walkActions.join('+'),
              recordId: rec.recordId,
              clause: atom.clause,
              route: route.nodes.join('→'),
              taskId: atom.taskId ?? null,
            });
          }
          anchor = { certain: true, node: route.target };
        } else {
          const candidateReaches = [...new Set(alternatives.flatMap((a) => a.reachIds))];
          const qId = ask({
            kind: 'ambiguous-route',
            recordId: rec.recordId,
            clause: atom.clause,
            landmark: mentions.map((m) => `${m.raw}→[${m.nodes.join('/')}]`).join('；'),
            alternatives: alternatives.map((a) => ({ reachIds: a.reachIds, route: a.nodes.join('→') })),
            detail: '存在多条不连通的走法，未澄清前任何一条都不能记为完成',
          });
          for (const rid of candidateReaches) linkQuestion(rid, qId);
          anchor = { certain: false, questionId: qId, candidates: candidateReaches };
        }
      }

      if (isRemote) {
        const candidates = remoteCandidates(graph, atom, mentions, rec.team, onBranchNodes).filter(
          (rid) => !evidenceByReach.get(rid)?.some((e) => e.kind === 'covered'),
        );
        const qId = ask({
          kind: 'remote-only',
          recordId: rec.recordId,
          clause: atom.clause,
          detail: '远望/隔河望见不等于走到对岸，按巡规不能算完成',
          candidates,
        });
        for (const rid of candidates) linkQuestion(rid, qId);
      }

      if (isMiss) {
        const miss = missCandidates(graph, atom, mentions, rec.team, anchor, evidenceByReach);
        if (miss.certainReach) {
          addEvidence(miss.certainReach, {
            kind: 'missed',
            recordId: rec.recordId,
            clause: atom.clause,
            taskId: atom.taskId ?? null,
          });
        } else {
          const qId = ask({
            kind: 'unmapped-miss',
            recordId: rec.recordId,
            clause: atom.clause,
            unknownTerms: atom.unknownTerms,
            candidates: miss.candidateReaches,
            detail: '明确说没走到，但地标无法唯一落图；列出候选岸段待核对，不替班组选一个',
          });
          for (const rid of miss.candidateReaches) linkQuestion(rid, qId);
        }
      }
    }
    anchors.set(rec.team, anchor);
  }

  // 汇总每条岸段状态
  const reachStates = new Map();
  for (const reach of data.reaches) {
    const evidence = evidenceByReach.get(reach.id) ?? [];
    const kinds = new Set(evidence.map((e) => e.kind));
    let status;
    if (kinds.has('covered') && kinds.has('missed')) status = 'conflict';
    else if (kinds.has('covered')) status = 'covered';
    else if (kinds.has('missed')) status = 'missed';
    else if (evidence.some((e) => e.kind === 'remote')) status = 'remote';
    else status = 'unknown';
    reachStates.set(reach.id, {
      reachId: reach.id,
      status,
      team: reach.team,
      shore: reach.shore,
      entry: reach.entry,
      entryBlocked: (data.patrol.blockedEntries ?? []).includes(reach.entry),
      evidence,
      questionIds: candidateQuestionsByReach.get(reach.id) ?? [],
    });
  }

  // 补核任务校验：未回报不算完成；同段不得被两个在岗任务同时认领；封闭入口要提示
  const tasks = [...taskIndex.values()];
  const activeByReach = new Map();
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (!activeByReach.has(task.reachId)) activeByReach.set(task.reachId, []);
    activeByReach.get(task.reachId).push(task.id);
  }
  for (const [reachId, ids] of activeByReach) {
    if (ids.length > 1) {
      const qId = ask({
        kind: 'duplicate-dispatch',
        clause: ids.map((id) => `任务 ${id}`).join('、'),
        candidates: [reachId],
        detail: '同一岸段被多个未完成补核任务同时认领，需撤回其一',
      });
      linkQuestion(reachId, qId);
    }
  }
  for (const task of tasks) {
    const reach = graph.reachById.get(task.reachId);
    task.feasible = !(data.patrol.blockedEntries ?? []).includes(reach.entry);
    task.entryNote = task.feasible ? null : `规定入口 ${reach.entry} 封闭（桥/闸/封闭栈道限制），需另核可进出位置`;
  }

  // 补核回报与原班解释的一致性重判：
  // 回报里出现任务岸段端点之外的地标（例如从另一座桥转弯），原班解释与新班覆盖都要重判。
  for (const task of tasks) {
    if (task.status !== 'returned' || !task.report) continue;
    const reach = graph.reachById.get(task.reachId);
    const endpoints = new Set([reach.from, reach.to]);
    for (const rec of parsedRecords) {
      if (rec.recordId !== task.id) continue;
      for (const atom of rec.atoms) {
        if (atom.clarificationOnly) continue;
        for (const mention of atom.mentions) {
          const nodes = effectiveNodes(mention);
          const outside = nodes.filter((n) => !endpoints.has(n));
          if (outside.length > 0) {
            const qId = ask({
              kind: 'recheck-route-conflict',
              recordId: rec.recordId,
              clause: atom.clause,
              landmark: `${mention.raw}→[${nodes.join('/')}]，岸段 ${task.reachId} 端点为 ${[...endpoints].join('/')}`,
              candidates: [task.reachId],
              detail: `补核 ${task.id} 回报出现任务岸段端点之外的地标，原班解释与新班覆盖均需重判，不得直接销单`,
            });
            linkQuestion(task.reachId, qId);
          }
        }
      }
    }
  }

  return { reachStates, questions, tasks, graph, parsedRecords, patrol: data.patrol };
}

function remoteCandidates(graph, atom, mentions, team, onBranchNodes) {
  const ownShores = new Set(graph.teamShore.get(team) ?? []);
  const nodes = mentions.flatMap((m) => m.nodes);
  let pool;
  if (nodes.length > 0) {
    pool = new Set(nodes.flatMap((n) => reachesAtNode(graph, n)));
  } else if (atom.unknownTerms.some((t) => t.includes('支沟'))) {
    pool = new Set();
    for (const n of onBranchNodes) for (const rid of reachesAtNode(graph, n)) pool.add(rid);
  } else {
    pool = new Set([...graph.reachById.keys()]);
  }
  return [...pool].filter((rid) => !ownShores.has(graph.reachById.get(rid).shore));
}

function missCandidates(graph, atom, mentions, team, anchor, evidenceByReach) {
  const ownReaches = new Set(graph.teamReaches.get(team) ?? []);
  const nodes = mentions.flatMap((m) => m.nodes);
  const uncovered = (rid) => !evidenceByReach.get(rid)?.some((e) => e.kind === 'covered');

  if (nodes.length === 1 && atom.unknownTerms.length === 0) {
    // 地标唯一落图、且没有“下一个闸”这类未落图词，才允许唯一确定相邻漏查段
    const adjacent = reachesAtNode(graph, nodes[0]).filter((rid) => ownReaches.has(rid) && uncovered(rid));
    if (adjacent.length === 1) return { certainReach: adjacent[0], candidateReaches: adjacent };
  }

  let candidateReaches;
  if (anchor?.certain) {
    candidateReaches = reachesAtNode(graph, anchor.node).filter((rid) => ownReaches.has(rid) && uncovered(rid));
    // 当班岸段内没有候选（漏查点在对岸/支沟），放宽到该节点全部未覆盖段，仍只作候选提问
    if (candidateReaches.length === 0) {
      candidateReaches = reachesAtNode(graph, anchor.node).filter(uncovered);
    }
  } else {
    candidateReaches = [...ownReaches].filter(uncovered);
  }
  if (nodes.length > 1) {
    const near = new Set(nodes.flatMap((n) => reachesAtNode(graph, n)));
    const narrowed = candidateReaches.filter((rid) => near.has(rid));
    if (narrowed.length > 0) candidateReaches = narrowed;
  }
  return { candidateReaches: [...new Set(candidateReaches)] };
}

// 与 parser.buildAliasIndex 同构，避免 adjudicate 的调用方还要先建索引
function buildAliasIndexLocal(landmarks) {
  const index = new Map();
  for (const { node, aliases } of landmarks) {
    for (const alias of aliases) {
      if (!index.has(alias)) index.set(alias, []);
      index.get(alias).push(node);
    }
  }
  return index;
}

/**
 * 安排补核。只接受“已确定漏查/仅远望”的岸段；候选未定的岸段必须先消问题。
 * 返回任务草案，不直接写回资料；封闭入口时给出限制说明而不是硬派。
 */
export function planRecheck(result, reachId, team, now) {
  const state = result.reachStates.get(reachId);
  if (!state) throw new Error(`未知岸段 ${reachId}`);
  const active = result.tasks.filter((t) => t.status === 'pending' && t.reachId === reachId);
  if (active.length > 0) {
    return { ok: false, reason: 'duplicate', activeTaskIds: active.map((t) => t.id), question: null };
  }
  if (state.questionIds.length > 0 || state.status === 'unknown' || state.status === 'conflict') {
    return {
      ok: false,
      reason: 'needs-clarification',
      questionIds: state.questionIds,
      note: '岸段仍有候选解释未确认，先核对问题，不得靠挑一个解释派单',
    };
  }
  if (state.status === 'covered') return { ok: false, reason: 'already-covered' };
  const task = {
    id: `T${result.tasks.length + 1}`,
    reachId,
    team: team ?? state.team,
    status: 'pending',
    sentAt: now ?? new Date().toISOString(),
    entry: state.entry,
    entryBlocked: state.entryBlocked,
    entryNote: state.entryBlocked ? `规定入口 ${state.entry} 封闭，先确认替代进出位置` : null,
    basedOn: state.evidence.map((e) => ({ recordId: e.recordId, clause: e.clause })),
  };
  return { ok: true, task };
}
