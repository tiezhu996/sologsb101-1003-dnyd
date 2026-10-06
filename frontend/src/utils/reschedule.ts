/**
 * 计划改期：停梯检修做不成时，把某期未签署计划改到能做的日子，
 * 并把该电梯同周期后续未签署期次按各自周期顺延。
 *
 * 规则（业务口径，纯函数，便于复用与测试）：
 * 1. 只有「待执行 / 执行中」（未签署）的期次可以改期；已签署期次照原样保留。
 * 2. 顺延范围：该电梯、同一周期类型（半月/季度/年度）的期次序列，
 *    从目标期开始连续的未签署期次一起后移；中途一旦遇到已签署期次即停止，
 *    已签署期次作为不可逾越的时间锚点。
 * 3. 每一期都按「这期自己的周期」（plan.cycleType，15/90/365 天）从改后日期
 *    逐期后推，不读电梯档案里的 maintCycle——两者不一致时用档案周期会算错下一期。
 * 4. 不允许新旧日期叠在一起（同一台电梯任意两期同日期），
 *    也不允许排到已签署期次之前或把后面的已签署期次顶掉。
 * 5. 改完是否逾期仍由计划日期与今天比较得出（isPlanOverdue），
 *    改期本身不改状态：新日期早于今天的，照样提示逾期。
 */
import type { Plan } from '../types/plan';
import { addDays, CYCLE_DAYS } from './cycle';

/** 单期改期结果 */
export interface PlanRescheduleItem {
  planId: string;
  /** 原计划日期 yyyy-MM-dd */
  oldDate: string;
  /** 改后计划日期 yyyy-MM-dd */
  newDate: string;
  cycleType: Plan['cycleType'];
  state: Plan['state'];
}

/** 改期预案：描述目标期与顺延期将如何变化 */
export interface PlanRescheduleResult {
  ok: boolean;
  message: string;
  /** 目标期自身的改期结果；校验失败时可能为空数组 */
  changes: PlanRescheduleItem[];
  /** 顺延期数（不含目标期本身） */
  shiftedCount: number;
}

/** 校验 yyyy-MM-dd 日期字符串可解析 */
function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T00:00:00`).getTime());
}

/**
 * 计算改期预案（不落库）。
 *
 * @param plans 全量计划（store 中已加载的同一批即可，函数内自行按电梯/周期过滤）
 * @param targetPlanId 要改期的那一期
 * @param newDate 目标期改到的日期
 */
export function planReschedule(
  plans: Plan[],
  targetPlanId: string,
  newDate: string,
): PlanRescheduleResult {
  const target = plans.find((item) => item.id === targetPlanId);
  if (!target) {
    return { ok: false, message: '计划不存在，无法改期', changes: [], shiftedCount: 0 };
  }
  if (target.state === 'signed') {
    return { ok: false, message: '该期已签署，签署后的计划日期照原样保留', changes: [], shiftedCount: 0 };
  }
  if (!isValidDate(newDate)) {
    return { ok: false, message: '请选择有效的改期日期', changes: [], shiftedCount: 0 };
  }

  // 同电梯、同周期类型的期次序列，按计划日期升序（不同周期类型各自成链，互不顺延）
  const series = plans
    .filter((item) => item.elevatorId === target.elevatorId && item.cycleType === target.cycleType)
    .slice()
    .sort((a, b) => a.planDate.localeCompare(b.planDate));

  const targetIndex = series.findIndex((item) => item.id === targetPlanId);
  const predecessor = series[targetIndex - 1];

  // 目标期新日期必须晚于紧邻前一期（前一期已签署/未签署都不能被顶到它前面或叠期）
  if (predecessor && newDate <= predecessor.planDate) {
    return {
      ok: false,
      message: `改期日期需晚于上一期（${predecessor.planDate}），不能与已排期次叠期或排到前面`,
      changes: [],
      shiftedCount: 0,
    };
  }

  // 可移动块：从目标期起连续的未签署期次；遇到第一个已签署期次即停止顺延
  const movable: Plan[] = [];
  let blocker: Plan | null = null;
  for (let index = targetIndex; index < series.length; index += 1) {
    const current = series[index];
    if (current.state === 'signed') {
      blocker = current;
      break;
    }
    movable.push(current);
  }

  // 逐期后推：每一期都按「这期自己的周期」从改后日期往后算
  const changes: PlanRescheduleItem[] = [];
  let cursor = newDate;
  for (const plan of movable) {
    changes.push({
      planId: plan.id,
      oldDate: plan.planDate,
      newDate: cursor,
      cycleType: plan.cycleType,
      state: plan.state,
    });
    cursor = addDays(cursor, CYCLE_DAYS[plan.cycleType]);
  }

  // 可移动块不能越过后面第一个已签署期次（否则顺延期会排到已签署期次前面或叠期）
  if (blocker) {
    const lastMoved = changes[changes.length - 1];
    if (lastMoved.newDate >= blocker.planDate) {
      return {
        ok: false,
        message: `顺延后最后一期（${lastMoved.newDate}）会赶上或越过已签署期次（${blocker.planDate}），请选更早的日期`,
        changes: [],
        shiftedCount: 0,
      };
    }
  }

  // 叠期校验：改后日期不能与该电梯其它周期序列中不动的期次撞在同一天
  const movingIds = new Set(movable.map((item) => item.id));
  const newDateSet = new Set(changes.map((item) => item.newDate));
  const collision = plans.find(
    (item) =>
      item.elevatorId === target.elevatorId &&
      !movingIds.has(item.id) &&
      newDateSet.has(item.planDate),
  );
  if (collision) {
    return {
      ok: false,
      message: `改后日期与该电梯已排的${collision.state === 'signed' ? '已签署' : ''}期次（${collision.planDate}）撞期，请另选日期`,
      changes: [],
      shiftedCount: 0,
    };
  }

  if (changes.length === 1 && changes[0].newDate === target.planDate) {
    return { ok: true, message: '改期日期与原日期一致，无需顺延', changes, shiftedCount: 0 };
  }

  return {
    ok: true,
    message: `目标期改到 ${newDate}，后续 ${changes.length - 1} 期未签署计划按本周期顺延`,
    changes,
    shiftedCount: changes.length - 1,
  };
}
