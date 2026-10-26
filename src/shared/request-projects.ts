type RecordLike = Record<string, any>;
export type RecentProjects = Record<string, string>;
export const recentProjectsKey = 'wb-recent-projects-v1';

export function readRecentProjects(raw: string | null): RecentProjects {
  try {
    const value = JSON.parse(raw || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, at]) => id.length <= 200 && typeof at === 'string' && Number.isFinite(Date.parse(at))).sort((a,b) => String(b[1]).localeCompare(String(a[1]))).slice(0,50)) as RecentProjects;
  } catch { return {}; }
}

/** Actual visits and request edits count as use. Project creation/metadata updates do not. */
export function requestProjects(projects: RecordLike[], requests: RecordLike[], recent: RecentProjects): RecordLike[] {
  const used = new Map<string, number>();
  for (const [id, at] of Object.entries(recent)) used.set(id, Date.parse(at) || 0);
  for (const q of requests) {
    if (q.deleted_at || q.status === 'deleted') continue;
    const at = Date.parse(q.updated_at || q.created_at || '') || 0;
    used.set(q.project_id, Math.max(used.get(q.project_id) || 0, at));
  }
  return projects.filter(p => !p.archived && !p.shelved).sort((a,b) =>
    (used.get(b.id) || 0) - (used.get(a.id) || 0) || String(a.name).localeCompare(String(b.name), 'zh-CN') || String(a.id).localeCompare(String(b.id)));
}

export function defaultRequestProject(projects: RecordLike[], explicit?: string, route?: {page:string;id?:string;task?:string}, tasks: RecordLike[] = []): string {
  const available = new Set(projects.map(p => p.id));
  const contextual = route?.task ? tasks.find(t => t.id === route.task)?.project_id : ['projects','requests'].includes(route?.page || '') ? route?.id : undefined;
  return [explicit, contextual, projects[0]?.id].find(id => id && available.has(id)) || '';
}
