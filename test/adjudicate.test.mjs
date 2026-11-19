import test from 'node:test';
import assert from 'node:assert/strict';
import { adjudicate, planRecheck } from '../scripts/adjudicate.mjs';
import { readInputs } from '../scripts/inspect.mjs';
import { renderBoard } from '../scripts/board.mjs';

const base = await readInputs();

const clone = (overrides = {}) => ({
  ...structuredClone(base),
  handovers: structuredClone(base.handovers),
  ...overrides,
});

const stateOf = (result, id) => result.reachStates.get(id);
const kindsOf = (result, id) => stateOf(result, id).evidence.map((e) => e.kind);

test('真实资料：W1、W3 实地覆盖；W3 的到场不等于 W4 走完；W2/W4 保持无法确定并挂问题', () => {
  const result = adjudicate(base);
  assert.equal(stateOf(result, 'W1').status, 'covered');
  assert.deepEqual(kindsOf(result, 'W1'), ['covered']);

  // H1 走到支沟桥：沿支沟 a→c 的 W3 是实地走完；桥外 W4 只有 H2 过桥的 presence
  assert.equal(stateOf(result, 'W3').status, 'covered');
  assert.ok(kindsOf(result, 'W3').includes('covered'));
  assert.ok(kindsOf(result, 'W4').includes('presence'));
  assert.ok(!kindsOf(result, 'W4').includes('covered'));

  assert.equal(stateOf(result, 'W2').status, 'unknown');
  assert.equal(stateOf(result, 'W4').status, 'unknown');
  // W4 挂着远望/漏查候选问题；W2 是叙述完全未触及的空白段，状态本身即阻止误判完成
  assert.ok(stateOf(result, 'W4').questionIds.length >= 1);
  assert.ok(![...result.reachStates.values()].some((s) => s.status === 'covered' && s.reachId === 'W2'));
});

test('重名石桥在澄清前产生多路径问题，澄清后按支沟桥 c 重判', () => {
  const before = adjudicate(clone({ handovers: [base.handovers[0]] }));
  const q = before.questions.find((x) => x.kind === 'ambiguous-route' && x.clause.includes('石桥'));
  assert.ok(q);
  assert.ok(q.alternatives.length >= 2);
  assert.ok(q.alternatives.some((a) => a.reachIds.includes('W3')));
  assert.ok(q.alternatives.some((a) => a.reachIds.includes('W2')));

  const after = adjudicate(base);
  const h1Walk = [...after.reachStates.values()]
    .flatMap((s) => s.evidence)
    .find((e) => e.recordId === 'H1' && e.kind === 'covered' && e.clause.includes('石桥'));
  assert.equal(h1Walk.route, 'a→c');
});

test('远望产生 remote-only 问题且不能算完成，候选不含已覆盖段', () => {
  const result = adjudicate(base);
  const q = result.questions.find((x) => x.kind === 'remote-only');
  assert.ok(q);
  // W3 已被“走到支沟桥”实地覆盖，远望候选只剩同属对岸的 W4
  assert.deepEqual(q.candidates, ['W4']);
  assert.ok(!q.candidates.includes('W1'));
});

test('看到对岸与走到对岸证据不同：远望不覆盖，过桥只记 presence', () => {
  const fixture = clone({
    handovers: [
      { id: 'S1', team: 'A', sentAt: '2026-08-12T07:40:00+08:00', text: '过了老渡口，看到对岸支沟桥。' },
      { id: 'S2', team: 'A', sentAt: '2026-08-12T08:00:00+08:00', text: '走到支沟桥。' },
      { id: 'S3', team: 'A', sentAt: '2026-08-12T08:05:00+08:00', text: '过桥。' },
    ],
  });
  const result = adjudicate(fixture);
  const w3 = stateOf(result, 'W3');
  assert.ok(w3.evidence.some((e) => e.kind === 'presence'));
  // W4 只接到桥点的 presence，绝不能被记 covered
  const w4 = stateOf(result, 'W4');
  assert.ok(w4.evidence.some((e) => e.kind === 'presence'));
  assert.ok(!w4.evidence.some((e) => e.kind === 'covered'));
  assert.ok(result.questions.some((q) => q.kind === 'remote-only'));
});

test('唯一地标+明确漏查可确定漏查段；未知闸名只给候选提问', () => {
  const fixture = clone({
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' },
      { id: 'S2', team: 'A', sentAt: 't2', text: '没到石桥。' },
    ],
  });
  const result = adjudicate(fixture);
  // “石桥”有 b/c 两解 -> 不能确定，只能提问
  const missQ = result.questions.find((q) => q.kind === 'unmapped-miss' || q.kind === 'ambiguous-route');
  assert.ok(missQ);
  assert.ok(![...result.reachStates.values()].some((s) => s.status === 'missed'));
});

test('构造唯一漏查：单候选地标时漏查可落段', () => {
  const fixture = {
    reaches: [
      { id: 'R1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
      { id: 'R2', from: 'a', to: 'b', shore: 'left', team: 'A', entry: 'a' },
    ],
    landmarks: [
      { node: 'a', aliases: ['老渡口'] },
      { node: 'b', aliases: ['干河桥'] },
    ],
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' },
      { id: 'S2', team: 'A', sentAt: 't2', text: '没到干河桥。' },
    ],
    patrol: { qualifying: ['实地巡岸'], remote: '远望', blockedEntries: [] },
    flowNotes: [],
  };
  const result = adjudicate(fixture);
  assert.equal(stateOf(result, 'R1').status, 'covered');
  assert.equal(stateOf(result, 'R2').status, 'missed');
});

test('原路退回不补覆盖：入支后退回，不连通的近岸段不得记走过', () => {
  const fixture = clone({
    reaches: structuredClone(base.reaches),
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口，走到支沟桥，原路退回，再从闸边进去。' },
    ],
  });
  const result = adjudicate(fixture);
  // a→c 的 W3 是去程走到的；W2/W4 与去程不连通，不能被退回动作补成覆盖
  assert.ok(kindsOf(result, 'W3').includes('covered'));
  assert.ok(!kindsOf(result, 'W2').includes('covered'));
  assert.ok(!kindsOf(result, 'W4').includes('covered'));
});

test('补核回报“从另一座桥转弯”会重判：原班覆盖与新班覆盖同时保留待核对', () => {
  const fixture = clone({
    recheckTasks: [
      {
        id: 'T1',
        reachId: 'W4',
        team: 'B',
        status: 'returned',
        sentAt: 't1',
        reportedAt: 't2',
        report: '刚才从老渡口转弯，没到支沟桥。',
      },
    ],
  });
  const result = adjudicate(fixture);
  const task = result.tasks.find((t) => t.id === 'T1');
  assert.equal(task.status, 'returned');
  const w4 = stateOf(result, 'W4');
  // 回报里的地标（老渡口=a）不在任务岸段 W4(c→b) 端点内，必须生成重判问题，不得直接销单
  const conflict = result.questions.find((q) => q.kind === 'recheck-route-conflict');
  assert.ok(conflict);
  assert.ok(conflict.clause.includes('老渡口'));
  assert.ok(w4.questionIds.includes(conflict.id));
});

test('未回报的补核任务不算完成，且禁止同段重复派单', () => {
  const fixture = clone({
    recheckTasks: [
      { id: 'T1', reachId: 'W2', team: 'A', status: 'pending', sentAt: 't1' },
      { id: 'T2', reachId: 'W2', team: 'A', status: 'pending', sentAt: 't2' },
    ],
  });
  const result = adjudicate(fixture);
  assert.ok(result.questions.some((q) => q.kind === 'duplicate-dispatch'));
  assert.equal(stateOf(result, 'W2').status, 'unknown'); // 计划里写了路线也不算完成
  const plan = planRecheck(result, 'W2', 'A');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'duplicate');
});

test('封闭入口的任务给出限制说明，plan 对有候选问题的岸段拒单', () => {
  const fixture = clone({
    reaches: [
      { id: 'R1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
      { id: 'R2', from: 'a', to: 'b', shore: 'left', team: 'A', entry: 'b' },
    ],
    landmarks: [
      { node: 'a', aliases: ['老渡口'] },
      { node: 'b', aliases: ['干河桥'] },
    ],
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' },
      { id: 'S2', team: 'A', sentAt: 't2', text: '没到干河桥。' },
    ],
    patrol: { qualifying: ['实地巡岸'], remote: '远望', blockedEntries: ['b'] },
    recheckTasks: [{ id: 'T9', reachId: 'R2', team: 'A', status: 'pending', sentAt: 't1' }],
    flowNotes: [],
  });
  const result = adjudicate(fixture);
  const task = result.tasks.find((t) => t.id === 'T9');
  assert.equal(task.feasible, false);
  assert.match(task.entryNote, /封闭/);

  // 真实资料里 W2 仍有候选问题，派单必须被拒
  const real = adjudicate(base);
  const blocked = planRecheck(real, 'W2', 'A');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'needs-clarification');
});

test('已确定漏查段可派单，已覆盖段拒单', () => {
  const fixture = {
    reaches: [
      { id: 'R1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
      { id: 'R2', from: 'a', to: 'b', shore: 'left', team: 'A', entry: 'a' },
    ],
    landmarks: [
      { node: 'a', aliases: ['老渡口'] },
      { node: 'b', aliases: ['干河桥'] },
    ],
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' },
      { id: 'S2', team: 'A', sentAt: 't2', text: '没到干河桥。' },
    ],
    patrol: { qualifying: ['实地巡岸'], remote: '远望', blockedEntries: [] },
    flowNotes: [],
  };
  const result = adjudicate(fixture);
  const ok = planRecheck(result, 'R2', 'A', '2026-08-12T09:00:00+08:00');
  assert.equal(ok.ok, true);
  assert.equal(ok.task.reachId, 'R2');
  assert.deepEqual(ok.task.basedOn.map((e) => e.recordId), ['S2']);
  assert.equal(planRecheck(result, 'R1', 'A').ok, false);
});

test('每条结论都可回查原句、地标与入口限制', () => {
  const result = adjudicate(base);
  const text = renderBoard(result);
  assert.match(text, /过了老渡口/);
  assert.match(text, /支沟外面只隔河望过/);
  assert.match(text, /封闭入口：b/);
  for (const state of result.reachStates.values()) {
    for (const ev of state.evidence) assert.ok(ev.clause && ev.recordId);
  }
});

test('封闭入口排除不可达来路：首句唯一可走路径可判覆盖', () => {
  const fixture = {
    reaches: [
      { id: 'R1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
      { id: 'R2', from: 'a', to: 'b', shore: 'left', team: 'A', entry: 'b' },
    ],
    landmarks: [
      { node: 'a', aliases: ['老渡口'] },
      { node: 'b', aliases: ['干河桥'] },
    ],
    handovers: [{ id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' }],
    patrol: { qualifying: ['实地巡岸'], remote: '远望', blockedEntries: ['b'] },
    flowNotes: [],
  };
  const result = adjudicate(fixture);
  assert.equal(stateOf(result, 'R1').status, 'covered');
  assert.equal(stateOf(result, 'R2').status, 'unknown');
});

test('adjudicate 不修改输入资料（branch 标记等只在内部生效）', () => {
  const fixture = clone();
  const snapshot = structuredClone(fixture);
  adjudicate(fixture);
  assert.deepEqual(fixture.reaches, snapshot.reaches);
  assert.ok(fixture.reaches.every((r) => r.branch === undefined));
});

test('补核任务派出未回报时岸段状态不变，计划路线不等于完成', () => {
  const fixture = {
    reaches: [
      { id: 'R1', from: 'u', to: 'a', shore: 'left', team: 'A', entry: 'u' },
      { id: 'R2', from: 'a', to: 'b', shore: 'left', team: 'A', entry: 'a' },
    ],
    landmarks: [
      { node: 'a', aliases: ['老渡口'] },
      { node: 'b', aliases: ['干河桥'] },
    ],
    handovers: [
      { id: 'S1', team: 'A', sentAt: 't1', text: '过了老渡口。' },
      { id: 'S2', team: 'A', sentAt: 't2', text: '没到干河桥。' },
    ],
    patrol: { qualifying: ['实地巡岸'], remote: '远望', blockedEntries: [] },
    flowNotes: [],
    recheckTasks: [
      { id: 'T1', reachId: 'R2', team: 'A', status: 'pending', sentAt: 't3', plannedRoute: 'a→b' },
    ],
  };
  const result = adjudicate(fixture);
  assert.equal(stateOf(result, 'R2').status, 'missed');
  assert.ok(!stateOf(result, 'R2').evidence.some((e) => e.kind === 'covered'));
});
