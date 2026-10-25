import type {Row} from './schema.ts';

/** Which local client a team member really uses; null when the workbench has no automatic route for it. */
export function agentClientKind(agent:Row):string|null {
  return ({'deepseek':'dsh','zcode':'dsh','glm':'dsh','claude-code':'claude','claude':'claude','cursor':'cursor','grok-build':'grok'} as Record<string,string>)[agent.preset_id||agent.id]||null;
}
