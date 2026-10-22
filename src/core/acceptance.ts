// 只描述用户能够确认的使用结果；技术标准仍保存在 task.acceptance。
export const defaultUserAcceptance = [
  '我已查看或试用本次交付的结果',
  '结果符合我的需求，可以结束这项任务',
];

export function userAcceptanceItems(task: { user_acceptance?: string[] }): string[] {
  return task.user_acceptance?.length ? task.user_acceptance : defaultUserAcceptance;
}

export function reviewSkipped(task: {reviewer_id?: string | null; review_policy?: {mode?: string; source?: string}}): boolean {
  return task.reviewer_id === null && task.review_policy?.mode === 'not_requested' && task.review_policy.source === 'user_requested';
}
