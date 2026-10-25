export type PlanningChannel='chat_paste'|'chat_mcp'|'manager_mcp'|'planner_mcp'|'page_import'|'internal';
export type PlanningOrigin={channel:PlanningChannel;authenticated_role:string|null;reported_name:string|null;reported_model:string|null;model_status:'reported'|'unknown'};
/** A connection proves its role, not the model behind it. Preserve that distinction. */
export function planningOriginLabel(row:Record<string,any>):string{
  const origin=row.planning_origin as PlanningOrigin|undefined;
  if(!origin)return row.source==='codex_plan'?'Codex（历史记录）':'规划来源未知';
  const channels:Record<PlanningChannel,string>={chat_paste:'GPT 聊天（粘贴回传）',chat_mcp:'聊天规划（MCP）',manager_mcp:'规划 Agent（管理连接）',planner_mcp:'规划 Agent（MCP）',page_import:'页面导入计划',internal:'规划来源未登记'};
  const reported=origin.reported_name?` · 自述 ${origin.reported_name}`:'';
  return (channels[origin.channel]||'规划来源未知')+reported;
}
