// 值班处看板：把判定结果分成“已覆盖 / 仅远望 / 已确定漏查 / 无法确定 / 补核任务 / 待核对问题”。
// 每个判断都带原句、地标候选与当班入口限制，可回查。

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { adjudicate, planRecheck } from './adjudicate.mjs';

export async function loadAndAdjudicate(file = new URL('../data/inputs.json', import.meta.url)) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  return { data, result: adjudicate(data) };
}

const STATUS_LABEL = {
  covered: '已覆盖（实地巡岸，可算完成）',
  remote: '仅远望（按巡规不算完成）',
  missed: '已确定漏查（应安排补核）',
  unknown: '无法确定（证据不足/有候选未确认）',
  conflict: '证据冲突（同段既称走过又称漏查，需重判）',
};

const GROUP_ORDER = ['covered', 'remote', 'missed', 'conflict', 'unknown'];

function renderEvidence(ev) {
  const label = {
    covered: (e) => `走过（${e.action}，路线 ${e.route}）`,
    missed: () => '明确漏查',
    presence: (e) => `现场到场但未走完（${e.route}）`,
    remote: () => '远望（不算完成）',
  };
  const lines = ev.map((e) => {
    const body = label[e.kind] ? label[e.kind](e) : e.kind;
    return `    · [${e.recordId}] ${body}｜原句：「${e.clause}」${e.taskId ? `｜补核任务 ${e.taskId}` : ''}`;
  });
  return lines.length ? lines.join('\n') : '    （无直接证据）';
}

export function renderBoard(result) {
  const groups = new Map(GROUP_ORDER.map((s) => [s, []]));
  for (const state of result.reachStates.values()) groups.get(state.status).push(state);

  const out = [];
  out.push('================ 河道巡查值班看板 ================');
  out.push(`巡规可算完成的动作：${result.patrol.qualifying.join('、')}；远望类动作：${result.patrol.remote}（不算完成）`);
  out.push(`封闭入口：${result.patrol.blockedEntries.join('、') || '无'}`);
  out.push('');

  for (const status of GROUP_ORDER) {
    const list = groups.get(status);
    if (!list.length) continue;
    out.push(`【${STATUS_LABEL[status]}】`);
    for (const s of list) {
      out.push(`  岸段 ${s.reachId}（${s.shore === 'left' ? '左岸' : '右岸'}，责任班组 ${s.team}，规定入口 ${s.entry}${s.entryBlocked ? '——已封闭' : ''}）`);
      out.push(renderEvidence(s.evidence));
      if (s.questionIds.length) out.push(`    关联待核对问题：${s.questionIds.join('、')}`);
    }
    out.push('');
  }

  out.push('【补核任务】');
  if (!result.tasks.length) out.push('  （暂无任务；注意：只有“已确定漏查/仅远望”的岸段可派单，未定候选先消问题）');
  for (const t of result.tasks) {
    const st = t.status === 'pending' ? '已派出未回报' : t.status === 'returned' ? '已回报待重判' : t.status;
    out.push(`  ${t.id} 岸段 ${t.reachId}｜班组 ${t.team}｜状态：${st}｜入口 ${t.entry}${t.entryBlocked ? '（封闭）' : ''}`);
    if (t.entryNote) out.push(`    限制：${t.entryNote}`);
    if (t.report) out.push(`    回报原句：「${t.report}」（新班覆盖与原班解释需一起重判）`);
  }
  out.push('');

  out.push('【待核对问题（不得靠挑一个解释抹掉）】');
  if (!result.questions.length) out.push('  （无）');
  for (const q of result.questions) {
    out.push(`  ${q.id} 类型：${q.kind}｜${q.detail ?? ''}`);
    if (q.clause) out.push(`    原句：「${q.clause}」${q.recordId ? `（来自 ${q.recordId}）` : ''}`);
    if (q.landmark) out.push(`    地标候选：${q.landmark}`);
    if (q.alternatives?.length) {
      for (const alt of q.alternatives) out.push(`    可行走法：${alt.route}（岸段 ${alt.reachIds.join('、')}）`);
    }
    if (q.candidates?.length) out.push(`    候选岸段：${q.candidates.join('、')}`);
    if (q.unknownTerms?.length) out.push(`    未落图地名：${q.unknownTerms.join('、')}`);
  }
  return out.join('\n');
}

const HELP = `用法：
  node scripts/board.mjs [资料路径]          打印中文值班看板
  node scripts/board.mjs --json [资料路径]   输出机器可读判定结果
  node scripts/board.mjs plan <岸段> [班组]   生成补核任务草案（不写回资料）
`;

async function main() {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  const planIdx = argv.indexOf('plan');
  const positional = argv.filter((a) => !a.startsWith('--') && a !== 'plan');
  const file = positional.find((a) => !['plan'].includes(a) && a.includes('.')) ?? new URL('../data/inputs.json', import.meta.url);
  const { result } = await loadAndAdjudicate(file);

  if (planIdx !== -1) {
    const reachId = argv[planIdx + 1];
    const team = argv[planIdx + 2];
    if (!reachId) {
      console.error(HELP);
      process.exitCode = 1;
      return;
    }
    const decision = planRecheck(result, reachId, team);
    console.log(JSON.stringify(decision, null, 2));
    return;
  }

  if (jsonMode) {
    const serializable = {
      reachStates: [...result.reachStates.values()],
      questions: result.questions,
      tasks: result.tasks,
    };
    console.log(JSON.stringify(serializable, null, 2));
    return;
  }
  console.log(renderBoard(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
