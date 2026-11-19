import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAliasIndex,
  scanMentions,
  parseRecord,
  applyClarifications,
  effectiveNodes,
  extractVerbalRoute,
  interpretDirection,
} from '../scripts/parser.mjs';
import { buildGraph, findWalkPaths, branchNodes } from '../scripts/graph.mjs';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();
const aliasIndex = buildAliasIndex(data.landmarks);
const graph = buildGraph(data.reaches);
const teamShore = new Map([...graph.teamShore].map(([k, v]) => [k, [...v]]));
const ctx = {
  aliasIndex,
  flowNotes: data.flowNotes,
  teamShore,
  onBranchNodes: branchNodes(data.reaches, data.landmarks),
};

test('俗名重名时保留全部候选节点，不就近选名', () => {
  const { mentions } = scanMentions('走到石桥才回', aliasIndex);
  assert.equal(mentions.length, 1);
  assert.deepEqual(mentions[0].nodes, ['b', 'c']);
  assert.equal(mentions[0].raw, '石桥');
});

test('长俗名优先，老渡口不会被“渡口”截断', () => {
  const { mentions, unknownTerms } = scanMentions('过了老渡口', aliasIndex);
  assert.deepEqual(mentions.map((m) => m.raw), ['老渡口']);
  assert.deepEqual(mentions[0].nodes, ['a']);
  assert.deepEqual(unknownTerms, []);
});

test('动作识别：远望、没到、过桥、原路退回、直到、过了', () => {
  const cases = [
    ['支沟外面只隔河望过', ['remote']],
    ['过桥后没走到下一个闸', ['miss', 'cross']],
    ['原路退回再从闸边进去', ['return', 'enter']],
    ['直到石桥', ['walk']],
    ['过了老渡口', ['pass']],
  ];
  for (const [clause, want] of cases) {
    const rec = { id: 'T', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: clause };
    const parsed = parseRecord(rec, ctx);
    assert.deepEqual(parsed.atoms[0].actions, want, clause);
  }
});

test('“看到对岸”是远望，“走到对岸”是实地跨岸', () => {
  const see = parseRecord(
    { id: 'T', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: '看到对岸有人' },
    ctx,
  ).atoms[0];
  const reach = parseRecord(
    { id: 'T', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: '走到对岸' },
    ctx,
  ).atoms[0];
  assert.ok(see.actions.includes('remote'));
  assert.ok(!see.actions.includes('cross'));
  assert.ok(reach.actions.includes('cross'));
  assert.ok(!reach.actions.includes('remote'));
});

test('未知地名保留为 unknownTerms，不猜节点；光杆“桥/闸”不当地名', () => {
  const parsed = parseRecord(
    { id: 'T', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: '没走到下一个闸，过桥就回' },
    ctx,
  );
  const terms = parsed.atoms.flatMap((a) => a.unknownTerms);
  assert.ok(terms.includes('下一个闸'));
  assert.ok(!terms.includes('桥'));
  assert.ok(!terms.includes('闸'));
});

test('“X指Y”澄清只解历史观察，澄清句自身不进待澄清队列', () => {
  const h1 = parseRecord(
    { id: 'H1', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: '走到石桥才回' },
    ctx,
  );
  const h2 = parseRecord(
    { id: 'H2', team: 'A', sentAt: '2026-08-12T08:10:00+08:00', text: '刚才写的石桥指支沟桥' },
    ctx,
  );
  applyClarifications([h1, h2], aliasIndex);
  const h1Mention = h1.atoms[0].mentions[0];
  assert.equal(h1Mention.resolvedNode, 'c');
  assert.equal(h1Mention.resolvedBy, 'H2');
  assert.deepEqual(effectiveNodes(h1Mention), ['c']);
  assert.equal(h2.atoms[0].clarificationOnly, true);
});

test('澄清目标本身有歧义时不改写，留 unresolved 而非任选一个', () => {
  const idx = buildAliasIndex([
    { node: 'a', aliases: ['老渡口'] },
    { node: 'b', aliases: ['石桥'] },
    { node: 'c', aliases: ['石桥'] },
  ]);
  const h1 = parseRecord(
    { id: 'H1', team: 'A', sentAt: 't1', text: '走到石桥才回' },
    { ...ctx, aliasIndex: idx },
  );
  const h2 = parseRecord(
    { id: 'H2', team: 'A', sentAt: 't2', text: '刚才写的石桥指石桥' },
    { ...ctx, aliasIndex: idx },
  );
  applyClarifications([h1, h2], idx);
  const m = h1.atoms[0].mentions[0];
  assert.ok(m.unresolved);
  assert.equal(m.resolvedNode, undefined);
  assert.deepEqual(effectiveNodes(m), ['b', 'c']);
});

test('口头“顺队”路线能从流向说明抽出', () => {
  const route = extractVerbalRoute(data.flowNotes, aliasIndex);
  assert.deepEqual(route.route, ['a', 'c']);
  assert.equal(route.noteId, 'F1');
});

test('下游类词在支沟语境保留水文与口头两套解释，不替值班员二选一', () => {
  const dir = interpretDirection('顺水往下', data.flowNotes, true, aliasIndex);
  assert.equal(dir.token, '顺水');
  assert.deepEqual(dir.interpretations.map((i) => i.basis), ['hydrological', 'verbal-handover']);
  const mainOnly = interpretDirection('顺水往下', data.flowNotes, false, aliasIndex);
  assert.deepEqual(mainOnly.interpretations.map((i) => i.basis), ['hydrological']);
});

test('河网步行连通按无向邻接，但每条路径保留岸段身份', () => {
  const paths = findWalkPaths(graph, 'a', 'c');
  const direct = paths.find((p) => p.reachIds.length === 1);
  assert.ok(direct);
  assert.deepEqual(direct.reachIds, ['W3']);
  const viaB = paths.find((p) => p.nodes.join('') === 'abc');
  assert.ok(viaB);
  assert.deepEqual(viaB.reachIds, ['W2', 'W4']);
});

test('不连通的节点对返回空路径，不允许空间就近补连通', () => {
  const g2 = buildGraph([
    { id: 'X1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
    { id: 'X2', from: 'x', to: 'y', shore: 'right', team: 'B', entry: 'x' },
  ]);
  assert.deepEqual(findWalkPaths(g2, 'a', 'x'), []);
});

test('支沟节点由“支沟”俗名兜底识别', () => {
  assert.deepEqual([...branchNodes(data.reaches, data.landmarks)].sort(), ['c']);
});
