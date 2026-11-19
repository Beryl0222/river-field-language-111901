// 中文巡查叙述解析器
// 职责：把交接/补核原文拆成小句，识别动作、地标、岸别、方向，产出“证据原子”。
// 不做河网连通推断（那是 graph.mjs 的职责），地标有歧义时保留全部候选节点，绝不就近选名。

const CLAUSE_END = /[。；;！!？?]+/;
const CLAUSE_SEP = /[，,、]+/;

// 动作规则按优先级排列；一条小句可同时命中多个动作（如“过桥后没走到闸”= 过桥 + 没到）。
const ACTION_RULES = [
  { action: 'miss', re: /没有走到|没走到|未走到|没巡到|未巡到|没到|未到/ },
  { action: 'remote', re: /隔河望|远望|望过|望见|遥望|望到|看到对岸|望见对岸|看见对岸/ },
  { action: 'cross', re: /过桥|穿过桥|走到对岸|踏上对岸|渡到对岸/ },
  { action: 'return', re: /原路退回|原路返回|折返|退回|才回|返回/ },
  { action: 'enter', re: /(?<!没)(?<!未)(?<!不)从[^，。；]{1,10}?(?:进去|进入)/ },
  { action: 'pass', re: /过了/ },
  { action: 'walk', re: /(?<!没)(?<!未)(?<!不)走到|巡到|直到|步行/ },
  { action: 'turn', re: /转弯|拐弯|折向/ },
];

const QUALIFYING = new Set(['pass', 'walk', 'cross', 'enter']);
const DIRECTION_RE = /顺水| downstream|下游|逆流|上游|顺队|逆向|反向/u;
const DIRECTION_TOKENS = ['顺水', '下游', '逆流', '上游', '顺队', '逆向', '反向'];
const PLACE_NOUN_RE = /[一-龥]{0,4}(?:闸|桥|渡口|栈道|河口|汇口)/g;
const CLARIFY_RE = /(?:刚才写的|前面说的|前述|此前说的)?([^，。；]{1,12}?)(?:指的是|指|即)([^，。；]{1,12})/;

/** 由 landmarks 建 俗名 -> 节点数组 的索引（允许重名）。 */
export function buildAliasIndex(landmarks) {
  const index = new Map();
  for (const { node, aliases } of landmarks) {
    for (const alias of aliases) {
      if (!index.has(alias)) index.set(alias, []);
      index.get(alias).push(node);
    }
  }
  return index;
}

/** 长名优先扫描，避免“老渡口”被“渡口”抢先匹配。 */
export function scanMentions(clause, aliasIndex) {
  const names = [...aliasIndex.keys()].sort((a, b) => b.length - a.length);
  const mentions = [];
  const occupied = [];
  for (const name of names) {
    let from = 0;
    let idx;
    while ((idx = clause.indexOf(name, from)) !== -1) {
      from = idx + name.length;
      if (occupied.some(([s, e]) => idx < e && idx + name.length > s)) continue;
      occupied.push([idx, idx + name.length]);
      mentions.push({ raw: name, index: idx, nodes: aliasIndex.get(name) });
    }
  }
  mentions.sort((a, b) => a.index - b.index);

  // 小句里出现了地点性名词却匹配不到任何俗名 -> 未知地名，留给判定阶段提问，不允许猜节点。
  // 剥掉动词/指示词前缀；“桥、闸”这类光杆泛称属于动作用词，不作为未知地名。
  const BARE_GENERIC = new Set(['桥', '闸', '渡口', '栈道', '河口', '汇口']);
  const unknownTerms = [];
  const matchedText = new Set(mentions.map((m) => m.raw));
  for (const m of clause.matchAll(PLACE_NOUN_RE)) {
    const term = m[0]
      .replace(/^[到过从往在再然后接着先又]+/g, '')
      .replace(/^(边|旁|口|头)+/, '');
    if (!term || BARE_GENERIC.has(term)) continue;
    if (matchedText.has(term)) continue;
    if (mentions.some((x) => term.includes(x.raw) || x.raw.includes(term))) continue;
    unknownTerms.push(term);
  }
  return { mentions, unknownTerms: [...new Set(unknownTerms)] };
}

function detectActions(clause) {
  const actions = [];
  for (const { action, re } of ACTION_RULES) {
    if (re.test(clause)) actions.push(action);
  }
  return actions;
}

function detectShore(clause, team, teamShore) {
  const local = /左岸/.test(clause) ? 'left' : /右岸/.test(clause) ? 'right' : null;
  if (local) return { kind: local, raw: local === 'left' ? '左岸' : '右岸' };
  if (/对岸/.test(clause)) {
    const own = teamShore.get(team);
    return { kind: 'opposite', raw: '对岸', observerShores: own ? [...own] : [] };
  }
  return null;
}

/**
 * 方向词解释。水文方向始终保留；若 flowNotes 定义了口头交接方向且当前语境在支沟，
 * 再追加口头方向解释。两种解释并存，不替值班员二选一。
 */
export function interpretDirection(clause, flowNotes, onBranch, aliasIndex) {
  const token = DIRECTION_TOKENS.find((t) => clause.includes(t));
  if (!token) return null;
  const interpretations = [
    { basis: 'hydrological', note: '按河网有向边 from→to 解释（下游=边方向）' },
  ];
  const verbal = extractVerbalRoute(flowNotes, aliasIndex);
  if (verbal && onBranch) {
    interpretations.push({
      basis: 'verbal-handover',
      note: `按口头交接“${verbal.raw}”解释：${verbal.fromName}→${verbal.toName}`,
      route: verbal.route,
    });
  }
  return { token, interpretations };
}

/** 从流向说明原文里抽取“从X往Y算顺队”的口头路线（俗名允许部分匹配，如 渡口⊂老渡口）。 */
export function extractVerbalRoute(flowNotes, aliasIndex) {
  for (const note of flowNotes ?? []) {
    const m = note.text.match(/从([^，。；]{1,10}?)往([^，。；]{1,10}?)算顺队/);
    if (!m) continue;
    const fromNode = resolveLoose(m[1], aliasIndex);
    const toNode = resolveLoose(m[2], aliasIndex);
    if (fromNode && toNode && fromNode.length === 1 && toNode.length === 1) {
      return {
        noteId: note.id,
        raw: m[0],
        fromName: m[1],
        toName: m[2],
        route: [fromNode[0], toNode[0]],
      };
    }
  }
  return null;
}

function resolveLoose(phrase, aliasIndex) {
  for (const [name, nodes] of aliasIndex) {
    if (phrase.includes(name) || name.includes(phrase)) return nodes;
  }
  return null;
}

function splitClauses(text) {
  return text
    .split(CLAUSE_END)
    .flatMap((sentence) => sentence.split(CLAUSE_SEP))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析一条叙述记录。
 * @returns {{recordId, team, sentAt, atoms: Array, clarifications: Array}}
 */
export function parseRecord(record, ctx) {
  const { aliasIndex, flowNotes, teamShore, onBranchNodes } = ctx;
  const clauses = splitClauses(record.text);
  const atoms = [];
  const clarifications = [];

  clauses.forEach((clause, clauseIndex) => {
    const clarify = clause.match(CLARIFY_RE);
    if (clarify) {
      clarifications.push({
        recordId: record.id,
        clauseIndex,
        clause,
        rawName: clarify[1].replace(/^(刚才写的|前面说的|前述|此前说的)/, ''),
        targetName: clarify[2],
      });
    }

    const actions = detectActions(clause);
    if (actions.length === 0 && !clarify) return;

    const { mentions, unknownTerms } = scanMentions(clause, aliasIndex);
    const onBranch = mentions.some((m) => m.nodes.some((n) => onBranchNodes?.has(n)));
    atoms.push({
      recordId: record.id,
      team: record.team,
      sentAt: record.sentAt,
      clauseIndex,
      clause,
      actions,
      qualifying: actions.some((a) => QUALIFYING.has(a)),
      mentions, // 歧义原样保留：nodes 可能有多个
      unknownTerms,
      shore: detectShore(clause, record.team, teamShore),
      direction: interpretDirection(clause, flowNotes, onBranch, aliasIndex),
      clarificationOnly: Boolean(clarify) && actions.length === 0,
      type: record.type ?? 'handover',
      taskId: record.taskId ?? null,
    });
  });

  return { recordId: record.id, team: record.team, sentAt: record.sentAt, atoms, clarifications };
}

/**
 * 应用“X指Y”类澄清：把后续记录对先前歧义地标的指定，写回对应 mention。
 * 规则：同一班组、时间上最近一条未澄清的同名 mention。无法定位 target 俗名时不改写，转为问题。
 */
export function applyClarifications(parsedRecords, aliasIndex) {
  const pending = [];
  for (const rec of parsedRecords) {
    for (const atom of rec.atoms) {
      // 澄清句本身是“定义”而非观察，其中的地标不参与待澄清队列，
      // 否则“X指Y”会先把本句里的 X 自己解掉，真正的历史观察反而悬空。
      if (atom.clarificationOnly) continue;
      for (const mention of atom.mentions) {
        if (mention.nodes.length > 1) pending.push({ team: rec.team, mention, atom });
      }
    }
    for (const c of rec.clarifications) {
      const targetNodes = aliasIndex.get(c.targetName);
      const idx = [...pending].reverse().findIndex(
        (p) => p.team === rec.team && p.mention.raw === c.rawName && !p.mention.resolvedBy);
      if (idx === -1) continue;
      const hit = pending[pending.length - 1 - idx];
      if (targetNodes && targetNodes.length === 1) {
        hit.mention.resolvedNode = targetNodes[0];
        hit.mention.resolvedBy = rec.recordId;
        hit.mention.resolvedClause = c.clause;
      } else {
        hit.mention.unresolved = { reason: '澄清目标本身有歧义或不存在', targetName: c.targetName, by: rec.recordId };
      }
    }
  }
  return parsedRecords;
}

/** mention 的有效节点：澄清后取唯一节点，否则返回全部候选。 */
export function effectiveNodes(mention) {
  if (mention.resolvedNode) return [mention.resolvedNode];
  return mention.nodes;
}

export function parseAll(records, ctx) {
  const sorted = [...records].sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
  return applyClarifications(sorted.map((r) => parseRecord(r, ctx)), ctx.aliasIndex);
}
