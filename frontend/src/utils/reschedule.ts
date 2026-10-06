/**
 * 保养计划改期与后续未签署期次顺延。
 * 仅处理同电梯、同周期的期次；已签署期次作为固定锚点，不修改其日期。
 */
import type { Plan } from '../types/plan';
import { MAINT_CYCLE_LABEL } from '../types/elevator';
import { addDays, CYCLE_DAYS } from './cycle';

export interface PlanRescheduleUpdate {
  planId: string;
  fromDate: string;
  toDate: string;
  target: boolean;
}

export type PlanRescheduleResult =
  | { ok: true; updates: PlanRescheduleUpdate[]; followingCount: number; message: string }
  | { ok: false; message: string };

function normalizeDate(value: string): string | null {
  const text = value.slice(0, 10);
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 计算改期结果：
 * - 目标期次必须未签署；
 * - 后续未签署期次按目标期次自身周期依次顺延；
 * - 遇到已签署期次时保留原日期，并以其作为后续顺延锚点；
 * - 若顺延日期撞上或越过固定的已签署期次，则本次改期不可执行。
 */
export function reschedulePlanDates(
  allPlans: Plan[],
  planId: string,
  newPlanDate: string,
): PlanRescheduleResult {
  const target = allPlans.find((plan) => plan.id === planId);
  if (!target) return { ok: false, message: '计划不存在' };
  if (target.state === 'signed') return { ok: false, message: '已签署计划不能改期' };

  const requestedDate = normalizeDate(newPlanDate);
  if (!requestedDate) return { ok: false, message: '请选择有效的改期日期' };

  const series = allPlans
    .filter((plan) => plan.elevatorId === target.elevatorId && plan.cycleType === target.cycleType)
    .sort((a, b) => a.planDate.localeCompare(b.planDate) || a.id.localeCompare(b.id));
  const targetIndex = series.findIndex((plan) => plan.id === planId);
  const previous = series[targetIndex - 1];
  if (previous && requestedDate <= previous.planDate) {
    return {
      ok: false,
      message: `改期日期必须晚于上一期 ${previous.planDate}${
        previous.state === 'signed' ? '（已签署期次日期固定）' : ''
      }`,
    };
  }

  const updates: PlanRescheduleUpdate[] = [
    { planId: target.id, fromDate: target.planDate, toDate: requestedDate, target: true },
  ];
  const cycleDays = CYCLE_DAYS[target.cycleType];
  let cursor = requestedDate;

  for (let index = targetIndex + 1; index < series.length; index += 1) {
    const plan = series[index];
    if (plan.state === 'signed') {
      if (plan.planDate <= cursor) {
        return {
          ok: false,
          message: `无法顺延：${plan.planDate} 是已签署期次，日期必须保留，请选择更早的改期日期`,
        };
      }
      cursor = plan.planDate;
      continue;
    }

    const idealDate = addDays(cursor, cycleDays);
    const candidate = idealDate > plan.planDate ? idealDate : plan.planDate;
    updates.push({ planId: plan.id, fromDate: plan.planDate, toDate: candidate, target: false });
    cursor = candidate;
  }

  const updateById = new Map(updates.map((item) => [item.planId, item.toDate]));
  const scheduledDates = new Set<string>();
  for (const plan of series) {
    const planDate = updateById.get(plan.id) ?? plan.planDate;
    if (scheduledDates.has(planDate)) {
      return { ok: false, message: `改期后 ${planDate} 存在重叠的保养期次，请重新选择日期` };
    }
    scheduledDates.add(planDate);
  }

  const followingCount = updates.length - 1;
  return {
    ok: true,
    updates,
    followingCount,
    message:
      followingCount > 0
        ? `本期已改期，后续 ${followingCount} 期未签署计划已按${MAINT_CYCLE_LABEL[target.cycleType]}周期顺延`
        : '本期已改期',
  };
}
