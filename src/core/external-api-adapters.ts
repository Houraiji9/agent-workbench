import {getExternalPreset, type ExternalPreset} from './external-provider-catalog.ts';

export interface ExternalApiConnection {
  presetId: string;
  baseUrl?: string;
  model?: string;
  region?: string;
  config?: Record<string, unknown>;
}
export interface ExternalApiRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}
export interface ExternalApiArtifact {
  type: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  base64?: string;
  mimeType?: string;
}
export interface ExternalApiResult {
  status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'unknown';
  taskId?: string;
  fileId?: string;
  text?: string;
  toolCalls?: {id: string; name: string; arguments: string}[];
  artifacts?: ExternalApiArtifact[];
  usage?: Record<string, number>;
  errorCode?: string;
}

type Dict = Record<string, unknown>;
const record = (value: unknown): Dict => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const id = (value: unknown): string | undefined => typeof value === 'string' && /^[\w.-]{1,256}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少或无效的 ${name}`);
  return value;
};
const requiredId = (value: unknown, name: string): string => {
  const result = id(value);
  if (!result) throw new Error(`缺少或无效的 ${name}`);
  return result;
};
const pick = (input: Dict, keys: string[]): Dict => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));

function presetFor(connection: ExternalApiConnection, operation: string): ExternalPreset {
  const preset = getExternalPreset(connection.presetId);
  if (!preset || preset.kind !== 'api') throw new Error('此连接不是已登记的 API 预设');
  if (!preset.operations.includes(operation)) throw new Error(`此预设尚未适配操作 ${operation}`);
  return preset;
}

function baseUrlFor(connection: ExternalApiConnection, preset: ExternalPreset): URL {
  let url: URL;
  try { url = new URL(requiredString(connection.baseUrl || preset.baseUrl, '服务地址')); }
  catch { throw new Error('服务地址必须是有效的 HTTPS URL'); }
  // Loopback HTTP allows isolated local fixtures and explicitly configured local gateways.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('服务地址仅支持 HTTPS 或本机回环 HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含凭据、查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

/** Pure request construction: caller owns secret retrieval, origin checks, budget checks and HTTP. */
export function buildExternalApiRequest(connection: ExternalApiConnection, operation: string,
  input: Record<string, unknown>, secrets: Record<string, string>): ExternalApiRequest {
  const preset = presetFor(connection, operation);
  const base = baseUrlFor(connection, preset);
  const keyName = preset.authFields[0];
  const secret = requiredString(secrets[keyName], keyName);
  if (/[\r\n\0]/.test(secret)) throw new Error('凭据含无效控制字符');
  if (input.stream === true) throw new Error('此调用入口暂不支持流式传输，请使用非流式参数');
  const headers: Record<string, string> = {'Content-Type': 'application/json', Authorization: `Bearer ${secret}`};
  if (preset.protocol === 'pixverse-video') {
    delete headers.Authorization;
    headers['API-KEY'] = secret;
    const traceId = requiredString(input.traceId, 'traceId（每个请求独立的 UUID）');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) throw new Error('traceId 必须是 UUID v4');
    headers['Ai-trace-id'] = traceId;
  }
  const request = (path: string, method: 'GET' | 'POST', body?: Dict, query?: Dict): ExternalApiRequest => {
    const url = new URL(path, base);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const result: ExternalApiRequest = {url: url.toString(), method, headers: {...headers}};
    if (body !== undefined) result.body = body;
    return result;
  };
  const model = () => requiredString(input.model ?? connection.model, 'model');
  const prompt = () => requiredString(input.prompt, 'prompt');

  if (operation === 'chat') {
    const messages = input.messages ?? [{role: 'user', content: prompt()}];
    if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages 必须是非空数组');
    return request('chat/completions', 'POST', {...pick(input, ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'response_format', 'thinking', 'reasoning_effort', 'stop']), model: model(), messages, stream: false});
  }

  if (operation === 'image.generate' || operation === 'image.edit') {
    if (preset.protocol === 'minimax-native') {
      // Use the documented URL response variant; MiniMax's body is not OpenAI Images.
      return request('image_generation', 'POST', {...pick(input, ['aspect_ratio', 'width', 'height', 'n', 'seed', 'prompt_optimizer']), model: model(), prompt: prompt(), response_format: 'url'});
    }
    if (preset.protocol === 'volcengine-ark') {
      let image = input.image;
      if (image === undefined && input.images !== undefined) {
        if (!Array.isArray(input.images) || input.images.length === 0) throw new Error('images 必须是非空 image_url 引用数组');
        image = input.images.map(value => {
          const reference = imageReference(value);
          if (!reference.image_url) throw new Error('方舟图像引用仅支持 image_url，不支持 OpenAI file_id');
          return reference.image_url;
        });
      }
      if (image !== undefined) {
        if (typeof image === 'string') image = imageReference({image_url: image}).image_url;
        else if (Array.isArray(image) && image.length) image = image.map(value => imageReference({image_url: value}).image_url);
        else throw new Error('image 必须是 URL/data URL 或非空数组');
      }
      if (operation === 'image.edit' && image === undefined) throw new Error('图像编辑需要 image URL 或 data URL');
      return request('images/generations', 'POST', {...pick(input, ['size', 'seed', 'guidance_scale', 'watermark', 'sequential_image_generation', 'sequential_image_generation_options', 'output_format']), ...(image === undefined ? {} : {image}), model: model(), prompt: prompt(), response_format: 'url', stream: false});
    }
    if (preset.protocol === 'siliconflow') {
      return request('images/generations', 'POST', {...pick(input, ['image_size', 'negative_prompt', 'seed', 'num_inference_steps', 'guidance_scale', 'cfg', 'image', 'image2', 'image3']), model: model(), prompt: prompt()});
    }
    if (preset.protocol === 'openai-images') {
      if (input.background === 'transparent' && input.output_format === 'jpeg') throw new Error('透明背景需要 PNG 或 WebP 输出');
      const body: Dict = {...pick(input, ['size', 'n', 'quality', 'background', 'output_format', 'output_compression', 'safety_identifier']), model: model(), prompt: prompt()};
      // Current Images API supports JSON image references. No local path is read here.
      if (operation === 'image.edit') {
        if (input.input_fidelity !== undefined) body.input_fidelity = input.input_fidelity;
        if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 16) throw new Error('images 需要 1 到 16 个 image_url 或 file_id 引用');
        body.images = input.images.map((item) => imageReference(item));
        if (input.mask !== undefined) body.mask = imageReference(input.mask);
        if (input.markup !== undefined) body.markup = imageReference(input.markup);
        if (body.mask && body.markup) throw new Error('mask 和 markup 不能同时设置');
      } else if (input.moderation !== undefined) body.moderation = input.moderation;
      body.stream = false;
      return request(operation === 'image.edit' ? 'images/edits' : 'images/generations', 'POST', body);
    }
    // BigModel image generation shares the route, but not OpenAI's entire parameter surface.
    return request('images/generations', 'POST', {...pick(input, ['size']), model: model(), prompt: prompt()});
  }

  if (preset.protocol === 'minimax-native') {
    if (operation === 'video.create') return request('video_generation', 'POST', {...pick(input, ['duration', 'resolution', 'prompt_optimizer', 'fast_pretreatment']), model: model(), prompt: prompt()});
    if (operation === 'video.status') return request('query/video_generation', 'GET', undefined, {task_id: requiredId(input.taskId ?? input.task_id, 'taskId')});
    if (operation === 'file.retrieve') return request('files/retrieve', 'GET', undefined, {file_id: requiredId(input.fileId ?? input.file_id, 'fileId')});
  }
  if (preset.protocol === 'minimax-video-v2' || preset.protocol === 'volcengine-ark') {
    const isArk = preset.protocol === 'volcengine-ark';
    if (operation === 'video.create') {
      const content = input.content ?? [{type: 'text', text: prompt()}];
      if (!Array.isArray(content) || content.length === 0) throw new Error('content 必须是非空数组');
      if (!isArk) {
        if (!content.some(value => record(value).type === 'text' && string(record(value).text)?.trim())) throw new Error('MiniMax H3 content 必须包含非空 text 提示词');
        const resolution = requiredString(input.resolution, 'resolution（MiniMax H3 必填）');
        if (!['480P', '768P', '2K'].includes(resolution)) throw new Error('MiniMax H3 resolution 仅支持 480P、768P 或 2K，具体档位需匹配模型');
        if (!Number.isInteger(input.duration) || Number(input.duration) < 4 || Number(input.duration) > 15) throw new Error('MiniMax H3 duration 必须为 4 到 15 的整数');
        const selectedModel = model();
        if (selectedModel === 'MiniMax-H3' && resolution === '480P'
          || ['MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'].includes(selectedModel) && resolution === '2K') throw new Error('resolution 与所选 MiniMax H3 型号不匹配');
        if (selectedModel === 'MiniMax-H3-Max' && Number(input.duration) < 5) throw new Error('MiniMax H3 Max duration 至少为 5 秒');
        const onlyText = content.every(value => record(value).type === 'text');
        if (onlyText && (!string(input.ratio) || input.ratio === 'adaptive')) throw new Error('MiniMax H3 文生视频必须指定非 adaptive 的 ratio');
        if (input.ratio !== undefined && !['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(String(input.ratio))) throw new Error('MiniMax H3 ratio 不在支持范围内');
        if (selectedModel === 'MiniMax-H3-Lite' && (!string(input.ratio) || input.ratio === 'adaptive')) throw new Error('MiniMax H3 Lite 必须指定具体 ratio');
      }
      return request(isArk ? 'contents/generations/tasks' : 'video_generation', 'POST', {
        ...pick(input, isArk ? ['duration', 'resolution', 'ratio', 'frames', 'seed', 'watermark', 'generate_audio', 'camera_fixed', 'return_last_frame', 'execution_expires_after', 'service_tier', 'draft']
          : ['duration', 'resolution', 'ratio', 'aigc_watermark']), model: model(), content
      });
    }
    if (operation === 'video.status') return request(`${isArk ? 'contents/generations/tasks' : 'query/video_generation'}/${requiredId(input.taskId ?? input.task_id, 'taskId')}`, 'GET');
  }
  if (preset.protocol === 'dashscope-video') {
    if (operation === 'video.create') {
      headers['X-DashScope-Async'] = 'enable';
      return request('services/aigc/video-generation/video-synthesis', 'POST', {model: model(), input: {prompt: prompt(), ...pick(input, ['negative_prompt', 'audio_url'])}, parameters: pick(input, ['size', 'resolution', 'ratio', 'duration', 'prompt_extend', 'watermark', 'seed'])});
    }
    if (operation === 'video.status') return request(`tasks/${requiredId(input.taskId ?? input.task_id, 'taskId')}`, 'GET');
  }
  if (preset.protocol === 'pixverse-video') {
    if (operation === 'video.create') return request('video/text/generate', 'POST', {...pick(input, ['duration', 'quality', 'aspect_ratio', 'negative_prompt', 'seed', 'style', 'motion_mode', 'sound_effect_switch']), model: model(), prompt: prompt()});
    if (operation === 'video.status') return request(`video/result/${requiredId(input.taskId ?? input.video_id, 'taskId')}`, 'GET');
  }
  throw new Error(`此预设尚未适配操作 ${operation}`);
}

function imageReference(value: unknown): Dict {
  const reference = record(value);
  if (Object.keys(reference).some(key => !['image_url', 'file_id'].includes(key))) throw new Error('图像引用只接受 image_url 或 file_id，不接受本地路径');
  const imageUrl = string(reference.image_url), fileId = string(reference.file_id);
  if (Boolean(imageUrl) === Boolean(fileId)) throw new Error('图像引用必须且只能提供 image_url 或 file_id');
  if (fileId) return {file_id: requiredId(fileId, 'file_id')};
  if (!/^https:\/\//i.test(imageUrl!) && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageUrl!)) throw new Error('image_url 仅接受 HTTPS URL 或 PNG/JPEG/WebP data URL');
  if (/^https:/i.test(imageUrl!)) {
    let url: URL;
    try { url = new URL(imageUrl!); } catch { throw new Error('无效 image_url'); }
    if (url.username || url.password) throw new Error('image_url 不能包含 URL 凭据');
  }
  return {image_url: imageUrl};
}

const usageKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'generated_images', 'input_images', 'total_seconds', 'input_seconds', 'output_seconds', 'input_image_count', 'input_audio_seconds', 'credits', 'duration', 'input_video_duration', 'output_video_duration', 'video_count'];
function usageOf(value: unknown): Record<string, number> | undefined {
  const source = record(value), result: Record<string, number> = {};
  for (const key of usageKeys) if (typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) result[key] = source[key];
  return Object.keys(result).length ? result : undefined;
}
function artifactUrl(value: unknown, type: ExternalApiArtifact['type']): ExternalApiArtifact | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return;
    return {type, url: value};
  } catch { return; }
}
function imageArtifacts(value: unknown, mimeType?: string): ExternalApiArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const entry = record(item), url = artifactUrl(entry.url, 'image');
    if (url) return [url];
    const base64 = string(entry.b64_json);
    if (base64 && /^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return [{type: 'image', base64, ...(mimeType ? {mimeType} : {})} as ExternalApiArtifact];
    return [];
  });
}
function normalizedStatus(value: unknown): ExternalApiResult['status'] {
  const status = String(value ?? '').toLowerCase();
  if (['succeeded', 'success'].includes(status)) return 'succeeded';
  if (['failed', 'fail', 'cancelled', 'canceled', 'expired'].includes(status)) return 'failed';
  if (['queued', 'pending', 'preparing', 'queueing', 'submitted'].includes(status)) return 'submitted';
  if (['running', 'processing'].includes(status)) return 'running';
  return 'unknown';
}
function resultWithArtifacts(result: ExternalApiResult, artifacts: ExternalApiArtifact[]): ExternalApiResult {
  if (artifacts.length) result.artifacts = artifacts;
  return result;
}

/** Parse only known response fields. Never return raw payloads, response headers or vendor error text. */
export function parseExternalApiResponse(connection: ExternalApiConnection, operation: string,
  body: unknown, httpStatus = 200): ExternalApiResult {
  const preset = presetFor(connection, operation), source = record(body);
  const baseCode = record(source.base_resp).status_code;
  if (httpStatus < 200 || httpStatus >= 300 || source.error || (baseCode !== undefined && baseCode !== 0)
      || (source.ErrCode !== undefined && source.ErrCode !== 0) || (source.code !== undefined && (preset.protocol === 'dashscope-video' || preset.protocol === 'siliconflow'))) {
    const code = typeof baseCode === 'number' ? `provider_${baseCode}` : typeof source.ErrCode === 'number' ? `provider_${source.ErrCode}` : `http_${httpStatus}_provider_error`;
    return {status: 'failed', errorCode: code};
  }
  if (operation === 'chat') {
    const choices = Array.isArray(source.choices) ? source.choices : [];
    const message = record(record(choices[0]).message);
    const text = string(message.content);
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap(item => {
      const call = record(item), fn = record(call.function);
      const callId = id(call.id), name = string(fn.name), args = string(fn.arguments);
      return callId && name && args ? [{id: callId, name, arguments: args}] : [];
    });
    return {status: text || toolCalls.length ? 'succeeded' : 'unknown', ...(text ? {text} : {}), ...(toolCalls.length ? {toolCalls} : {}), ...(usageOf(source.usage) ? {usage: usageOf(source.usage)} : {})};
  }
  if (operation.startsWith('image.')) {
    const format = string(source.output_format), mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : format === 'png' ? 'image/png' : undefined;
    const artifacts = preset.protocol === 'minimax-native'
      ? (Array.isArray(record(source.data).image_urls) ? record(source.data).image_urls as unknown[] : []).flatMap(value => {const item = artifactUrl(value, 'image'); return item ? [item] : [];})
      : imageArtifacts(preset.protocol === 'siliconflow' ? source.images : source.data, mime);
    const entries = preset.protocol === 'siliconflow' ? source.images : source.data;
    const imageError = Array.isArray(entries) && entries.some(entry => Boolean(record(entry).error));
    const result: ExternalApiResult = {status: artifacts.length ? 'succeeded' : imageError ? 'failed' : 'unknown'};
    if (imageError) result.errorCode = artifacts.length ? 'partial_image_failure' : 'provider_image_error';
    const usage = usageOf(source.usage); if (usage) result.usage = usage;
    return resultWithArtifacts(result, artifacts);
  }
  if (preset.protocol === 'minimax-native') {
    if (operation === 'file.retrieve') {
      const file = record(source.file), artifact = artifactUrl(file.download_url, 'file');
      return {...resultWithArtifacts({status: artifact ? 'succeeded' : 'unknown'}, artifact ? [artifact] : []), ...(id(file.file_id) ? {fileId: id(file.file_id)} : {})};
    }
    const taskId = id(source.task_id), fileId = id(source.file_id);
    let status = operation === 'video.create' ? taskId ? 'submitted' as const : 'unknown' as const : normalizedStatus(source.status);
    if (status === 'succeeded' && !fileId) status = 'unknown';
    return {status, ...(taskId ? {taskId} : {}), ...(fileId ? {fileId} : {})};
  }
  if (preset.protocol === 'volcengine-ark' || preset.protocol === 'minimax-video-v2') {
    const task = preset.protocol === 'minimax-video-v2' && operation === 'video.status' ? record(source.task) : source;
    const taskId = id(task.id ?? task.task_id), status = operation === 'video.create' ? taskId ? 'submitted' : 'unknown' : normalizedStatus(task.status);
    const content = record(task.content), artifact = artifactUrl(preset.protocol === 'volcengine-ark' ? content.video_url : content.url, 'video');
    const result: ExternalApiResult = {status, ...(taskId ? {taskId} : {})};
    const usage = usageOf(task.usage); if (usage) result.usage = usage;
    if (status === 'succeeded' && !artifact) result.status = 'unknown';
    return resultWithArtifacts(result, status === 'succeeded' && artifact ? [artifact] : []);
  }
  if (preset.protocol === 'dashscope-video') {
    const output = record(source.output), taskId = id(output.task_id);
    const status = normalizedStatus(output.task_status), artifact = artifactUrl(output.video_url, 'video');
    const result: ExternalApiResult = {status: status === 'succeeded' && !artifact ? 'unknown' : status, ...(taskId ? {taskId} : {})};
    const usage = usageOf(source.usage); if (usage) result.usage = usage;
    return resultWithArtifacts(result, status === 'succeeded' && artifact ? [artifact] : []);
  }
  if (preset.protocol === 'pixverse-video') {
    const response = record(source.Resp), taskId = id(response.video_id ?? response.id), artifact = artifactUrl(response.url, 'video');
    const status: ExternalApiResult['status'] = operation === 'video.create' ? taskId ? 'submitted' : 'unknown'
      : response.status === 1 ? artifact ? 'succeeded' : 'unknown' : response.status === 5 ? 'running' : response.status === 7 || response.status === 8 ? 'failed' : 'unknown';
    const result: ExternalApiResult = {status, ...(taskId ? {taskId} : {})};
    const usage = usageOf(response); if (usage) result.usage = usage;
    return resultWithArtifacts(result, status === 'succeeded' && artifact ? [artifact] : []);
  }
  return {status: 'unknown'};
}
