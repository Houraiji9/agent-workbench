import React, { useState } from 'react';
import { Avatar } from './kit.js';

// 本地静态图片；运行时不请求品牌网站。
const grok = new URL('../assets/agents/grok.svg', import.meta.url).href;
const antigravity = new URL('../assets/agents/antigravity.svg', import.meta.url).href;
const icons: Record<string, string> = {
  codex: new URL('../assets/agents/codex.svg', import.meta.url).href,
  zcode: new URL('../assets/agents/zcode.svg', import.meta.url).href,
  'grok-build': grok, 'grok-bot': new URL('../assets/agents/grok-bot.svg', import.meta.url).href, 'grok-search': grok,
  deepseek: new URL('../assets/agents/deepseek.svg', import.meta.url).href,
  gemini: new URL('../assets/agents/gemini.svg', import.meta.url).href,
  kimi: new URL('../assets/agents/kimi.svg', import.meta.url).href,
  workbuddy: new URL('../assets/agents/workbuddy.svg', import.meta.url).href,
  claude: new URL('../assets/agents/claude.svg', import.meta.url).href,
  'bolt': new URL('../assets/agents/bolt.svg', import.meta.url).href,
  'chatgpt': new URL('../assets/agents/chatgpt.svg', import.meta.url).href,
  'cline': new URL('../assets/agents/cline.svg', import.meta.url).href,
  'codebuddy': new URL('../assets/agents/codebuddy.svg', import.meta.url).href,
  'coze': new URL('../assets/agents/coze.svg', import.meta.url).href,
  'cursor': new URL('../assets/agents/cursor.svg', import.meta.url).href,
  'devin': new URL('../assets/agents/devin.svg', import.meta.url).href,
  'doubao': new URL('../assets/agents/doubao.svg', import.meta.url).href,
  'github-copilot': new URL('../assets/agents/github-copilot.svg', import.meta.url).href,
  'glm': new URL('../assets/agents/glm.svg', import.meta.url).href,
  'junie': new URL('../assets/agents/junie.svg', import.meta.url).href,
  'kiro': new URL('../assets/agents/kiro.svg', import.meta.url).href,
  'lingma': new URL('../assets/agents/lingma.svg', import.meta.url).href,
  'lovable': new URL('../assets/agents/lovable.svg', import.meta.url).href,
  'manus': new URL('../assets/agents/manus.svg', import.meta.url).href,
  'minimax': new URL('../assets/agents/minimax.svg', import.meta.url).href,
  'openclaw': new URL('../assets/agents/openclaw.svg', import.meta.url).href,
  'opencode': new URL('../assets/agents/opencode.svg', import.meta.url).href,
  'perplexity': new URL('../assets/agents/perplexity.svg', import.meta.url).href,
  'qoder': new URL('../assets/agents/qoder.svg', import.meta.url).href,
  'qwen': new URL('../assets/agents/qwen.svg', import.meta.url).href,
  'qwen-code': new URL('../assets/agents/qwen-code.svg', import.meta.url).href,
  'replit': new URL('../assets/agents/replit.svg', import.meta.url).href,
  'trae': new URL('../assets/agents/trae.svg', import.meta.url).href,
  'trae-cn': new URL('../assets/agents/trae-cn.svg', import.meta.url).href,
  'v0': new URL('../assets/agents/v0.svg', import.meta.url).href,
  'windsurf': new URL('../assets/agents/windsurf.svg', import.meta.url).href,
  'yuanbao': new URL('../assets/agents/yuanbao.svg', import.meta.url).href,
  antigravity, 'antigravity-flash': antigravity, 'antigravity-claude': antigravity,
};

export function AgentIcon({ name, id, size = 40 }: { name: string; id: string; size?: number }) {
  const src = icons[id];
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src || failedSrc === src) return <Avatar name={name} id={id==='auto'?name:id} size={size} />;
  return <span className="agent-icon" aria-hidden="true" style={{ width: size, height: size }}>
    <img src={src} alt="" width={size} height={size} draggable={false} onError={() => setFailedSrc(src)} />
  </span>;
}
