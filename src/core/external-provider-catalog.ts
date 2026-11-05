/** Public presets only. A documented protocol is not evidence of an installed or funded account. */
export interface ExternalPreset {
  id: string;
  name: string;
  vendor: string;
  kind: 'api' | 'cli' | 'agent_cli' | 'agent_mcp';
  protocol: string;
  baseUrl?: string;
  authFields: string[];
  capabilities: string[];
  /** Operations implemented by the corresponding adapter, not every vendor-advertised capability. */
  operations: string[];
  docsUrls: string[];
  notes: string[];
  availability: 'documented' | 'needs_verification';
  cli?: { commandCandidates: string[]; versionArgs: string[]; invocationNotes: string[] };
}

const api = (id: string, name: string, vendor: string, protocol: string, baseUrl: string,
  capabilities: string[], operations: string[], docsUrls: string[], notes: string[] = [],
  authFields = ['apiKey'], availability: ExternalPreset['availability'] = 'documented'): ExternalPreset =>
  ({id, name, vendor, kind: 'api', protocol, baseUrl, authFields, capabilities, operations, docsUrls, notes, availability});
const cli = (id: string, name: string, vendor: string, command: string, docsUrl: string,
  invocationNotes: string[], kind: 'cli' | 'agent_cli' = 'agent_cli', authFields: string[] = []): ExternalPreset =>
  ({id, name, vendor, kind, protocol: 'cli-json', authFields, capabilities: [kind === 'cli' ? 'media' : 'agent'],
    operations: ['cli.invoke'], docsUrls: [docsUrl], notes: ['本机版本、登录与调用能力需分别检测；不自动安装或切换账号。', ...invocationNotes], availability: 'documented',
    cli: {commandCandidates: [command, `${command}.exe`, `${command}.cmd`], versionArgs: ['--version'], invocationNotes}});

export const externalPresets: ExternalPreset[] = [
  api('minimax-chat', 'MiniMax 模型 API', 'MiniMax', 'openai-chat', 'https://api.minimax.cn/v1', ['text', 'tool_calling'], ['chat'],
    ['https://platform.minimax.cn/docs/api-reference/text-chat-openai'], ['按量 API 与 M Plan 的额度和 Key 分别配置；不要推断文本 Key 已开通媒体服务。']),
  api('minimax-media', 'MiniMax 图片 / 海螺 V1 视频 API', 'MiniMax', 'minimax-native', 'https://api.minimax.cn/v1', ['image', 'video'],
    ['image.generate', 'video.create', 'video.status', 'file.retrieve'],
    ['https://platform.minimax.cn/docs/api-reference/image-generation-t2i', 'https://platform.minimax.cn/docs/api-reference/video-generation-t2v', 'https://platform.minimax.cn/docs/api-reference/video-generation-query', 'https://platform.minimax.cn/docs/api-reference/file-management-retrieve'],
    ['此连接使用 V1 视频协议；H3 使用独立 V2 预设。V1 成功返回 file_id 后还需 file.retrieve 取得下载地址。', 'image.generate input={"model":"image-01","prompt":"海边小屋","aspect_ratio":"16:9","n":1}。video.create 请使用已开通的 V1 视频模型；返回 taskId 后查询原任务，不能重发创建。']),
  api('minimax-video-v2', 'MiniMax H3 视频 API V2', 'MiniMax', 'minimax-video-v2', 'https://api.minimax.cn/v2', ['video', 'audio_video'], ['video.create', 'video.status'],
    ['https://platform.minimax.cn/docs/api-reference/video-generation-v2-create', 'https://platform.minimax.cn/docs/api-reference/video-generation-v2-query'], ['使用 content 数组；与 V1 prompt 协议分开。模型与付费资格由账号决定。', 'video.create input={"model":"MiniMax-H3","prompt":"海浪缓缓拍岸","resolution":"768P","duration":5,"ratio":"16:9"}；resolution、duration 必填，纯文生视频 ratio 必填。H3-Max 最短 5 秒，各型号分辨率不同。', 'video.status input={"taskId":"创建结果的原始 taskId"}。此适配不支持 callback_url、H3-Max extra、取消或估价操作。']),
  cli('minimax-mmx', 'MiniMax CLI（mmx）', 'MiniMax', 'mmx', 'https://github.com/MiniMax-AI/cli', ['cli.invoke input={"args":["text","chat","--message","你好","--non-interactive","--quiet","--output","json"]}。生图将 text/chat 替换为 image/generate，使用 --prompt；视频增加 --async 并用 video task get --task-id 查询。', '图像 JSON 返回 saved 路径数组，工作台应按调用隔离保存目录并核验文件后归档；未配置隔离时 CLI 会在 cwd 写入可重名的 image_001.jpg。video --async 只返回 taskId，不代表完成；video generate 不支持 --out-dir。', '沿用 CLI 正式登录。当前官方源码仅从参数或已登录配置取 Key，与 skill 的 MINIMAX_API_KEY 环境示例不一致；环境 Key 支持须按本机版本核验，不将密钥加入 argv。', '本机 schema 可用 args=["config","export-schema"] 读取；不默认添加 --yes，不调用 agent setup 修改其他 Agent 配置。'], 'cli'),
  cli('minimax-mcode', 'MiniMax Code（mcode）', 'MiniMax', 'mcode', 'https://agent.minimax.io/docs/cli/automation', ['cli.invoke input={"args":["exec","--output-format","json","总结当前项目的测试入口"]}。或 args=["exec","--input","-","--output-format","json"] 并传 stdin；不能同时提供 stdin 和位置提示词。', 'exec 支持 text/json/stream-json；检查 JSON status 和退出码，不将 timeout/limit_exceeded 当成功。ACP 是单独协议入口，不经单次 cli.invoke 发送自然语言。']),
  {id: 'minimax-design', name: 'MiniMax Design（应用 MCP）', vendor: 'MiniMax', kind: 'agent_mcp', protocol: 'mcp', authFields: [], capabilities: ['design', 'agent'], operations: ['mcp.call'], docsUrls: ['https://design.minimax.io/'], notes: ['从应用的官方导出/接入功能导入 MCP 配置，鉴权字段由该配置确定，不猜测 token/header。不能扫描应用内部 gateway、复用隐藏凭据或猜测 CLI。'], availability: 'needs_verification'},
  {id: 'minimax-api-mcp', name: 'MiniMax 多媒体 API MCP', vendor: 'MiniMax', kind: 'agent_mcp', protocol: 'mcp', authFields: ['MINIMAX_API_KEY'], capabilities: ['image', 'video', 'speech'], operations: ['mcp.call'], docsUrls: ['https://platform.minimax.cn/docs/guides/mcp-guide'], notes: ['官方 stdio 服务通过 MINIMAX_API_KEY 环境变量鉴权；MINIMAX_API_HOST 等非敏感参数按官方配置导入。', '官方 API MCP 与 Design 应用 MCP、M Plan 搜索/图片理解 MCP 是不同连接；实际工具以 tools/list 为准。'], availability: 'documented'},
  {id: 'minimax-plan-mcp', name: 'MiniMax M Plan MCP', vendor: 'MiniMax', kind: 'agent_mcp', protocol: 'mcp', authFields: ['MINIMAX_API_KEY'], capabilities: ['search', 'vision_input'], operations: ['mcp.call'], docsUrls: ['https://platform.minimax.cn/docs/guides/token-plan-mcp-guide'], notes: ['stdio 服务使用 MINIMAX_API_KEY；搜索和图片理解不代表图片生成；套餐凭据与按量 API 分开。'], availability: 'documented'},
  api('volcengine-ark', '火山方舟 API', '火山引擎', 'volcengine-ark', 'https://ark.cn-beijing.volces.com/api/v3', ['text', 'image', 'video'], ['chat', 'image.generate', 'image.edit', 'video.create', 'video.status'],
    ['https://docs.volcengine.com/docs/ark/integrate-third-party-tools?lang=zh', 'https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh', 'https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh'], ['API Key 鉴权；模型 ID 或 Endpoint ID 必须保持原样。Agent Plan 与按量服务分别配置，不共享即梦网页积分。', '图像、视频和对话模型不同；分别建连接，或在每次 input.model 指定本操作的模型。image.generate input={"prompt":"海边小屋","size":"2K"}。image.edit input={"prompt":"更换背景","images":[{"image_url":"https://example.com/source.png"}]}。', 'video.create input={"prompt":"海浪缓缓拍岸","resolution":"720p","duration":5,"ratio":"16:9"}；video.status input={"taskId":"原始 taskId"}。模型支持的尺寸、时长、模态以官方说明为准。']),
  api('jimeng-api', '即梦开放平台 API（AK/SK）', '火山引擎', 'volcengine-visual-signature', 'https://visual.volcengineapi.com', ['image', 'video', 'digital_human'], [],
    ['https://docs.volcengine.com/docs/jimeng-ai/quick-start-1?lang=zh'], ['使用 AK/SK 签名，不是方舟 Bearer Key；专用签名适配尚未实现，保存连接不能视为已可调用。'], ['accessKey', 'secretKey'], 'needs_verification'),
  cli('dreamina-canvas', '即梦 Dreamina Canvas CLI', '即梦', 'dreamina-canvas', 'https://jimeng.jianying.com/', ['cli.invoke input={"args":["schema","--non-interactive","--format","json"]}；按返回 schema 构造本机版本参数，profile/region 独立配置。', 'node quote/confirm/run 与 operation status/wait 分开；积分确认不能跳过。生成参数必须先按 model list/find 与 schema 确认，不硬套其他 CLI 的 --prompt/--output。'], 'cli'),
  api('aliyun-bailian', '阿里云百炼 / Qwen API', '阿里云', 'openai-chat', 'https://dashscope.aliyuncs.com/compatible-mode/v1', ['text', 'tool_calling', 'vision_input'], ['chat'],
    ['https://help.aliyun.com/zh/model-studio/get-api-key', 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'], ['地域、业务空间、Key 和模型须匹配；Token Plan/Coding Plan 与按量 API 分开。']),
  api('aliyun-wan-video', '阿里云百炼 / 万相视频', '阿里云', 'dashscope-video', 'https://dashscope.aliyuncs.com/api/v1', ['video'], ['video.create', 'video.status'],
    ['https://help.aliyun.com/zh/model-studio/text-to-video-api-reference'], ['异步原生 API；支持配置业务空间专属域名。此适配为文生视频，模型具体参数以官方文档为准。']),
  api('aliyun-image', '阿里云百炼 / 通义图像', '阿里云', 'dashscope-image', 'https://dashscope.aliyuncs.com/api/v1', ['image'], [],
    ['https://help.aliyun.com/zh/model-studio/use-image-generation'], ['不同图像模型同步/异步协议不同；本轮保留配置预设，专用适配待核验。'], ['apiKey'], 'needs_verification'),
  cli('qwen-code', 'Qwen Code', '阿里云', 'qwen', 'https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md', ['cli.invoke input={"args":["-p","总结项目结构","--output-format","json"]}；支持 text/json/stream-json，按项目恢复会话；不可默认附加 --yolo。']),
  api('zhipu-bigmodel', '智谱 BigModel / GLM API', '智谱', 'openai-chat-image', 'https://open.bigmodel.cn/api/paas/v4', ['text', 'tool_calling', 'image'], ['chat', 'image.generate'],
    ['https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', 'https://docs.bigmodel.cn/cn/guide/models/image-generation/glm-image'], ['GLM-Image 与文本模型独立；Coding Plan 与通用 API Key 分别配置。']),
  cli('zcode', 'ZCode Agent CLI', '智谱', 'zcode', 'https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md', ['先以 cli.invoke input={"args":["--help"]} 核对本机；Agent CLI 与发行包启动器不同，不能把旧 dsh 路由当成 ZCode 原生入口。未核验本机 headless 参数前不提供生成模板。']),
  api('kimi-api', 'Kimi / Moonshot API', '月之暗面', 'openai-chat', 'https://api.moonshot.cn/v1', ['text', 'vision_input', 'tool_calling'], ['chat'],
    ['https://platform.kimi.com/docs/get-api-key'], ['平台已迁至 Kimi 品牌；保留可编辑服务地址，按账号地域和最新平台配置核对；不声明生图。']),
  cli('kimi-code', 'Kimi Code CLI', '月之暗面', 'kimi', 'https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command', ['cli.invoke input={"args":["-p","总结项目结构","--output-format","stream-json"]}；旧版 --print 参数不同，先检测版本。', '非交互权限默认值随版本不同；不能当作只读执行。stream-json 是多行事件，需核对最终事件，不能把首行当最终结果。']),
  api('deepseek-api', 'DeepSeek API', 'DeepSeek', 'openai-chat', 'https://api.deepseek.com', ['text', 'tool_calling'], ['chat'], ['https://api-docs.deepseek.com/'], ['API 与 Harness 分开；工具调用支持并不等于已经安装图片生成工具。']),
  cli('deepseek-harness', 'DeepSeek Harness', 'DeepSeek', 'dsh', 'https://github.com/deepseek-ai/deepseek-harness', ['先以 cli.invoke input={"args":["--help"]} 核对本机 headless/overlay/session 参数；不是所有版本都支持 -p。已有 OpenAI 文本 provider 与生图工具绑定分开保留。']),
  api('tencent-tokenhub', '腾讯 TokenHub / 混元', '腾讯云', 'openai-chat', 'https://tokenhub.tencentmaas.com/v1', ['text', 'tool_calling', 'vision_input'], ['chat'],
    ['https://cloud.tencent.com/document/product/1823/130078', 'https://intl.cloud.tencent.com/document/product/1300/78941?lang=en', 'https://cloud.tencent.com/document/product/1729/111007'], ['默认地址属于中国站广州；中国站新加坡使用 tokenhub-intl.tencentmaas.com，国际站使用 tencentcloudmaas.com 系列域名，不能跨站点混用 Key。', '新开通优先 TokenHub；此适配仅覆盖对话，不因平台列有媒体模型就声明媒体协议已适配。']),
  api('tencent-hunyuan-legacy', '腾讯混元旧兼容接口', '腾讯云', 'openai-chat', 'https://api.hunyuan.cloud.tencent.com/v1', ['text', 'vision_input'], ['chat'],
    ['https://cloud.tencent.com/document/product/1729/111007'], ['旧平台停止新增模型和新购服务，保留既有账号迁移用途。']),
  cli('codebuddy', 'CodeBuddy Code CLI', '腾讯云', 'codebuddy', 'https://www.codebuddy.ai/docs/cli/cli-reference', ['cli.invoke input={"args":["-p","总结项目结构","--output-format","json"]}；支持 text/json/stream-json、会话恢复和 MCP；与 WorkBuddy 应用分开。']),
  api('baidu-qianfan', '百度千帆 API V2', '百度智能云', 'openai-chat', 'https://qianfan.baidubce.com/v2', ['text', 'tool_calling'], ['chat'],
    ['https://ai.baidu.com/ai-doc/WENXINWORKSHOP/wm9cvs292'], ['V2 使用 API Key / Bearer；历史 AK/SK 认证不自动沿用；应用权限须单独核对。']),
  api('siliconflow', '硅基流动 API', '硅基流动', 'siliconflow', 'https://api.siliconflow.cn/v1', ['text', 'image', 'speech', 'video', 'embedding', 'rerank'], ['chat', 'image.generate'],
    ['https://docs.siliconflow.cn/docs/api/chat-completions-post', 'https://docs.siliconflow.cn/docs/api/images-generations-post'], ['每个模型能力不同；本轮执行适配仅覆盖对话和生图，其余保留平台能力描述。']),
  api('kling', '可灵 Kling API', '快手', 'kling-native', '', ['image', 'video'], [],
    ['https://kling.ai/document-api/api/get-started/authentication'], ['官方存在新版 API Key 与旧 AK/SK JWT；国内区域 endpoint 和账号协议需核验后再适配，不猜测可用地址。'], ['apiKey', 'accessKey', 'secretKey'], 'needs_verification'),
  api('pixverse', 'PixVerse / 拍我 AI API', '爱诗科技', 'pixverse-video', 'https://app-api.pixverse.ai/openapi/v2', ['video'], ['video.create', 'video.status'],
    ['https://docs.platform.pixverse.ai/start-here-2394989m0', 'https://docs.platform.pixverse.ai/text-to-video-13016634e0', 'https://docs.platform.pixverse.ai/query-task-status-43051212e0'], ['API-KEY 与每请求独立 Ai-trace-id；国内拍我与国际 PixVerse 的账户、区域、素材 ID 分开。']),
  api('iflytek-spark', '讯飞星火 HTTP API', '讯飞', 'openai-chat', 'https://spark-api-open.xf-yun.com/agent/v1', ['text', 'tool_calling'], ['chat'],
    ['https://www.xfyun.cn/doc/spark/X2-Flash.html'], ['此入口为 X2-Flash；不同星火服务 endpoint 不同。apiPassword 是该 HTTP 服务的凭据。'], ['apiPassword']),
  api('stepfun-api', '阶跃星辰 API', '阶跃星辰', 'openai-chat', 'https://api.stepfun.com/v1', ['text', 'vision_input'], [],
    ['https://platform.stepfun.com/'], ['API 协议与区域待进一步核验；不因 CLI 支持 API Key 就声明所有 HTTP 模态已适配。'], ['apiKey'], 'needs_verification'),
  cli('step-code', 'Step Code', '阶跃星辰', 'step', 'https://github.com/stepfun-ai/Step-Code/blob/main/README.md', ['先以 cli.invoke input={"args":["--help"]} 核对本机非交互参数；Step Plan OAuth 与按量 API Key 分开，国内/海外分开。Windows PowerShell 支持标为 beta；以本机版本诊断为准。']),
  cli('qoder', 'Qoder CLI', 'Qoder', 'qoder', 'https://docs.qoder.com/cli/run-in-scripts', ['cli.invoke input={"args":["-p","总结项目结构","--output-format","json"]}；支持 text/json/stream-json；未授权操作在 headless 中拒绝，必须保留权限语义。']),
  api('openai-images', 'OpenAI Images（Harness 生图工具）', 'OpenAI', 'openai-images', 'https://api.openai.com/v1', ['image'], ['image.generate', 'image.edit'],
    ['https://developers.openai.com/api/reference/resources/images/methods/generate', 'https://developers.openai.com/api/reference/resources/images/methods/edit'], ['图片模型由用户配置精确 ID；不覆盖现有文本 provider。此适配面向当前 GPT Image JSON 协议，不保证历史 DALL·E 参数兼容。', 'image.generate input={"prompt":"海边小屋","size":"1024x1024","output_format":"png"}。image.edit input={"prompt":"更换背景","images":[{"image_url":"https://example.com/source.png"}]}；也接受 file_id，mask 与 markup 互斥。本地图片由调用层授权读取后转成 data URL。']),
  api('custom-openai-chat', '自定义 OpenAI 兼容对话 API', '自定义', 'openai-chat', '', ['text'], ['chat'],
    ['https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create'], ['用户配置实际服务地址和模型；兼容性须按该供应商核验，不预设图像/视频支持。'])
];

export function getExternalPreset(id: string): ExternalPreset | undefined {
  return externalPresets.find(preset => preset.id === id);
}
