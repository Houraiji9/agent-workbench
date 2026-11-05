import {test} from 'node:test';
import assert from 'node:assert/strict';
import {externalPresets, getExternalPreset} from '../src/core/external-provider-catalog.ts';
import {buildExternalApiRequest as build, parseExternalApiResponse as parse} from '../src/core/external-api-adapters.ts';

const secret = {apiKey: 'synthetic-key-do-not-persist'};
const connect = (presetId: string) => ({presetId, model: 'fixture-model'});
const traceId = '550e8400-e29b-41d4-a716-446655440000';

test('预设分开标识 API、工具 CLI、Agent CLI 与应用 MCP，未适配服务不冒充可调用', () => {
  assert.equal(new Set(externalPresets.map(p => p.id)).size, externalPresets.length);
  for (const preset of externalPresets) {
    assert(preset.docsUrls.length && preset.docsUrls.every(url => url.startsWith('https://')));
    assert(preset.notes.length);
    assert(!JSON.stringify(preset).includes('synthetic-key'));
  }
  for (const key of ['minimax-chat', 'minimax-media', 'minimax-video-v2', 'minimax-mmx', 'minimax-mcode', 'minimax-design', 'minimax-api-mcp', 'volcengine-ark', 'jimeng-api', 'dreamina-canvas', 'deepseek-harness', 'openai-images', 'qwen-code', 'kimi-code', 'zcode', 'codebuddy', 'qoder', 'step-code']) assert(getExternalPreset(key));
  assert.equal(getExternalPreset('minimax-mmx')?.kind, 'cli');
  assert.equal(getExternalPreset('minimax-mcode')?.kind, 'agent_cli');
  assert.equal(getExternalPreset('minimax-design')?.kind, 'agent_mcp');
  assert.deepEqual(getExternalPreset('minimax-design')?.authFields, []);
  assert.deepEqual(getExternalPreset('minimax-api-mcp')?.authFields, ['MINIMAX_API_KEY']);
  assert.deepEqual(getExternalPreset('minimax-plan-mcp')?.operations, ['mcp.call']);
  assert.deepEqual(getExternalPreset('minimax-mmx')?.authFields, []);
  for (const preset of externalPresets.filter(p => p.cli)) {
    assert(preset.notes.some(note => note.includes('cli.invoke input=')), `${preset.id} 缺可用调用或检测模板`);
    assert(preset.cli!.invocationNotes.every(note => preset.notes.includes(note)), `${preset.id} 的调用说明未暴露给调用卡`);
  }
  assert.deepEqual(getExternalPreset('jimeng-api')?.authFields, ['accessKey', 'secretKey']);
  assert.deepEqual(getExternalPreset('kling')?.operations, []);
  assert.throws(() => build(connect('jimeng-api'), 'image.generate', {prompt: 'test'}, secret), /尚未适配/);
});

test('兼容 chat 保留精确模型 ID、路径与工具参数，凭据只进入请求头', () => {
  const request = build({presetId: 'deepseek-api', model: 'DeepSeek-EXACT-ID'}, 'chat', {prompt: '你好', tools: [{type: 'function'}], arbitrary: 'drop-me'}, secret);
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.headers.Authorization, `Bearer ${secret.apiKey}`);
  assert.equal(request.body?.model, 'DeepSeek-EXACT-ID');
  assert.equal(request.body?.stream, false);
  assert.deepEqual(request.body?.messages, [{role: 'user', content: '你好'}]);
  assert(!JSON.stringify(request.body).includes(secret.apiKey));
  assert(!('arbitrary' in request.body!));
  assert.throws(() => build(connect('deepseek-api'), 'chat', {prompt: 'test', stream: true}, secret), /流式/);
});

test('服务地址不能把 Key 放进 URL，拒绝远程明文、URL 凭据与 header 注入', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?token=x', 'https://example.com/v1#secret']) {
    assert.throws(() => build({...connect('custom-openai-chat'), baseUrl}, 'chat', {prompt: 'test'}, secret));
  }
  assert.equal(build({...connect('custom-openai-chat'), baseUrl: 'http://127.0.0.1:12345/v1/'}, 'chat', {prompt: 'test'}, secret).url, 'http://127.0.0.1:12345/v1/chat/completions');
  assert.throws(() => build(connect('deepseek-api'), 'chat', {prompt: 'test'}, {apiKey: 'abc\r\nX-Injected: yes'}), /控制字符/);
});

test('OpenAI Images 编辑使用 JSON 引用，不把文件路径或旧 response_format 发送给 GPT Image', () => {
  const request = build(connect('openai-images'), 'image.edit', {prompt: '替换背景', images: [{image_url: 'data:image/png;base64,aGVsbG8='}, {file_id: 'file-123'}], background: 'transparent', response_format: 'url'}, secret);
  assert.equal(request.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(request.body?.images, [{image_url: 'data:image/png;base64,aGVsbG8='}, {file_id: 'file-123'}]);
  assert(!('response_format' in request.body!));
  for (const images of [[], [{path: 'C:\\private.png'}], [{image_url: 'file:///C:/private.png'}], [{image_url: 'https://user:password@example.com/a.png'}], [{image_url: 'https://example.com/a.png', file_id: 'file-123'}]]) {
    assert.throws(() => build(connect('openai-images'), 'image.edit', {prompt: 'test', images}, secret));
  }
  assert.throws(() => build(connect('openai-images'), 'image.edit', {prompt: 'test', images: [{file_id: 'file-123'}], mask: {file_id: 'file-mask'}, markup: {file_id: 'file-mark'}}, secret), /不能同时/);
  assert.throws(() => build(connect('openai-images'), 'image.generate', {prompt: 'test', background: 'transparent', output_format: 'jpeg'}, secret), /PNG 或 WebP/);
  const generated = build(connect('openai-images'), 'image.generate', {prompt: 'test', input_fidelity: 'high'}, secret);
  assert(!('input_fidelity' in generated.body!));
});

test('生图响应只挑选产物和数值 usage，空输出或错误不算成功', () => {
  const result = parse(connect('openai-images'), 'image.generate', {data: [{b64_json: 'aGVsbG8='}], output_format: 'png', api_key: secret.apiKey, usage: {total_tokens: 3, secret: secret.apiKey}});
  assert.deepEqual(result, {status: 'succeeded', usage: {total_tokens: 3}, artifacts: [{type: 'image', base64: 'aGVsbG8=', mimeType: 'image/png'}]});
  assert.equal(parse(connect('openai-images'), 'image.generate', {data: []}).status, 'unknown');
  assert.equal(parse(connect('openai-images'), 'image.generate', {error: {message: secret.apiKey}}, 401).status, 'failed');
  assert(!JSON.stringify(parse(connect('openai-images'), 'image.generate', {error: {message: secret.apiKey}}, 401)).includes(secret.apiKey));
});

test('MiniMax 图片使用原生路径和 image_urls 响应', () => {
  const request = build(connect('minimax-media'), 'image.generate', {prompt: '测试', aspect_ratio: '16:9', n: 2, response_format: 'base64'}, secret);
  assert.equal(request.url, 'https://api.minimax.cn/v1/image_generation');
  assert.equal(request.body?.response_format, 'url');
  const result = parse(connect('minimax-media'), 'image.generate', {base_resp: {status_code: 0}, data: {image_urls: ['https://media.example/image.png']}});
  assert.deepEqual(result.artifacts, [{type: 'image', url: 'https://media.example/image.png'}]);
  assert.equal(parse(connect('minimax-media'), 'image.generate', {base_resp: {status_code: 1008, status_msg: secret.apiKey}}).status, 'failed');
});

test('硅基流动图像使用 image_size 和 images 响应，不套用 OpenAI 字段', () => {
  const connection = connect('siliconflow');
  const request = build(connection, 'image.generate', {prompt: '测试', image_size: '1024x1024', cfg: 4, size: 'not-supported', n: 9}, secret);
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/images/generations');
  assert.deepEqual(request.body, {image_size: '1024x1024', cfg: 4, model: 'fixture-model', prompt: '测试'});
  assert.equal(parse(connection, 'image.generate', {images: [{url: 'https://cdn.example/image.png'}], timings: {inference: 1}}).status, 'succeeded');
  assert.equal(parse(connection, 'image.generate', {data: [{url: 'https://cdn.example/image.png'}]}).status, 'unknown');
  assert.equal(parse(connection, 'image.generate', {code: 20012, message: secret.apiKey}).status, 'failed');
});

test('MiniMax V1 视频提交、查询和取文件是不同操作，查询不会创建新任务', () => {
  const connection = connect('minimax-media');
  assert.equal(build(connection, 'video.create', {prompt: '测试', duration: 6}, secret).url, 'https://api.minimax.cn/v1/video_generation');
  assert.deepEqual(parse(connection, 'video.create', {task_id: 'task-1', base_resp: {status_code: 0}}), {status: 'submitted', taskId: 'task-1'});
  const statusRequest = build(connection, 'video.status', {taskId: 'task-1'}, secret);
  assert.equal(statusRequest.method, 'GET');
  assert.equal(statusRequest.url, 'https://api.minimax.cn/v1/query/video_generation?task_id=task-1');
  assert.deepEqual(parse(connection, 'video.status', {task_id: 'task-1', status: 'Success', file_id: 'file-1'}), {status: 'succeeded', taskId: 'task-1', fileId: 'file-1'});
  assert.deepEqual(parse(connection, 'video.status', {task_id: 'task-1', status: 'Success'}), {status: 'unknown', taskId: 'task-1'});
  for (const [status, expected] of [['Preparing', 'submitted'], ['Queueing', 'submitted'], ['Processing', 'running'], ['Fail', 'failed']] as const) assert.equal(parse(connection, 'video.status', {task_id: 'task-1', status}).status, expected);
  assert.equal(build(connection, 'file.retrieve', {fileId: 'file-1'}, secret).url, 'https://api.minimax.cn/v1/files/retrieve?file_id=file-1');
  assert.equal(parse(connection, 'file.retrieve', {file: {file_id: 'file-1', download_url: 'https://cdn.example/video.mp4'}}).artifacts?.[0].url, 'https://cdn.example/video.mp4');
  assert.throws(() => build(connection, 'video.status', {taskId: '../other?token=secret'}, secret), /taskId/);
});

test('MiniMax H3 V2 不复用 V1 响应，终态缺产物保留未知', () => {
  const connection = connect('minimax-video-v2');
  assert.deepEqual(build(connection, 'video.create', {prompt: 'test', resolution: '768P', duration: 5, ratio: '16:9'}, secret).body?.content, [{type: 'text', text: 'test'}]);
  assert.equal(build(connection, 'video.status', {taskId: '123'}, secret).url, 'https://api.minimax.cn/v2/query/video_generation/123');
  assert.equal(parse(connection, 'video.status', {task: {id: '123', status: 'succeeded'}}).status, 'unknown');
  const result = parse(connection, 'video.status', {task: {id: '123', status: 'succeeded', content: {url: 'https://cdn.example/video.mp4'}, usage: {total_seconds: 5}}});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.artifacts?.[0].type, 'video');
  assert.deepEqual(result.usage, {total_seconds: 5});
});

test('MiniMax H3 校验真实必填字段，采用自己的水印字段并保留型号差异', () => {
  const connection = {presetId: 'minimax-video-v2', model: 'MiniMax-H3'};
  const valid = {prompt: 'test', resolution: '768P', duration: 5, ratio: '16:9'};
  for (const key of ['resolution', 'duration', 'ratio']) {
    const input: Record<string, unknown> = {...valid}; delete input[key];
    assert.throws(() => build(connection, 'video.create', input, secret), /resolution|duration|ratio/);
  }
  assert.throws(() => build(connection, 'video.create', {...valid, content: [{type: 'image_url', image_url: {url: 'https://example.com/a.png'}}]}, secret), /非空 text/);
  assert.throws(() => build(connection, 'video.create', {...valid, ratio: 'adaptive'}, secret), /ratio/);
  assert.throws(() => build(connection, 'video.create', {...valid, resolution: '480P'}, secret), /不匹配/);
  assert.throws(() => build({...connection, model: 'MiniMax-H3-Max'}, 'video.create', {...valid, duration: 4}, secret), /至少/);
  const request = build(connection, 'video.create', {...valid, aigc_watermark: true, watermark: false, camera_fixed: true}, secret);
  assert.equal(request.body?.aigc_watermark, true);
  assert(!('watermark' in request.body!));
  assert(!('camera_fixed' in request.body!));
});

test('方舟 Seedream 编辑与 Seedance 异步视频使用各自协议', () => {
  const connection = connect('volcengine-ark');
  const image = build(connection, 'image.edit', {prompt: 'change', image: ['https://image.example/a.png']}, secret);
  assert.equal(image.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  const unified = build(connection, 'image.edit', {prompt: 'change', images: [{image_url: 'https://image.example/a.png'}]}, secret);
  assert.deepEqual(unified.body?.image, ['https://image.example/a.png']);
  assert(!('images' in unified.body!));
  assert.throws(() => build(connection, 'image.edit', {prompt: 'change', images: [{file_id: 'file-1'}]}, secret), /不支持 OpenAI file_id/);
  assert.throws(() => build(connection, 'image.edit', {prompt: 'change', image: 'C:\\private.png'}, secret), /image_url/);
  assert.throws(() => build(connection, 'image.edit', {prompt: 'change'}, secret), /需要 image/);
  const video = build(connection, 'video.create', {prompt: 'test', duration: 5, callback_url: 'https://unwanted.example'}, secret);
  assert.equal(video.url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert(!('callback_url' in video.body!));
  assert.deepEqual(parse(connection, 'video.create', {id: 'cgt-123'}), {status: 'submitted', taskId: 'cgt-123'});
  assert.equal(parse(connection, 'video.status', {id: 'cgt-123', status: 'running'}).status, 'running');
  assert.equal(parse(connection, 'video.status', {id: 'cgt-123', status: 'expired'}).status, 'failed');
  assert.equal(parse(connection, 'video.status', {id: 'cgt-123', status: 'new_vendor_state'}).status, 'unknown');
  assert.equal(parse(connection, 'video.status', {id: 'cgt-123', status: 'succeeded', content: {video_url: 'https://cdn.example/video.mp4'}}).artifacts?.[0].type, 'video');
});

test('方舟组图逐项失败不会伪装未知或完整成功，错误全文不透传', () => {
  const connection = connect('volcengine-ark'), failed = {error: {code: 'ContentFilter', message: secret.apiKey}};
  const onlyFailed = parse(connection, 'image.generate', {data: [failed]});
  assert.deepEqual(onlyFailed, {status: 'failed', errorCode: 'provider_image_error'});
  const partial = parse(connection, 'image.generate', {data: [{url: 'https://cdn.example/good.png'}, failed]});
  assert.equal(partial.status, 'succeeded');
  assert.equal(partial.errorCode, 'partial_image_failure');
  assert.equal(partial.artifacts?.length, 1);
  assert(!JSON.stringify(partial).includes(secret.apiKey));
});

test('万相视频保留异步头和 task_id 轮询，业务错误即使 HTTP 200 也失败', () => {
  const connection = connect('aliyun-wan-video');
  const request = build(connection, 'video.create', {prompt: 'test', duration: 5, resolution: '720P', ratio: '16:9', audio_url: 'https://cdn.example/audio.mp3', audio: false}, secret);
  assert.equal(request.headers['X-DashScope-Async'], 'enable');
  assert.deepEqual(request.body?.input, {prompt: 'test', audio_url: 'https://cdn.example/audio.mp3'});
  assert.deepEqual(request.body?.parameters, {resolution: '720P', ratio: '16:9', duration: 5});
  assert.equal(build(connection, 'video.status', {taskId: 'wan-1'}, secret).url, 'https://dashscope.aliyuncs.com/api/v1/tasks/wan-1');
  assert.deepEqual(parse(connection, 'video.create', {output: {task_id: 'wan-1', task_status: 'PENDING'}}), {status: 'submitted', taskId: 'wan-1'});
  assert.equal(parse(connection, 'video.status', {output: {task_id: 'wan-1', task_status: 'SUCCEEDED', video_url: 'https://cdn.example/video.mp4'}}).status, 'succeeded');
  assert.deepEqual(parse(connection, 'video.status', {output: {task_status: 'SUCCEEDED', video_url: 'https://cdn.example/video.mp4'}, usage: {duration: 5, video_count: 1, ratio: '16:9'}}).usage, {duration: 5, video_count: 1});
  assert.equal(parse(connection, 'video.status', {code: 'InvalidApiKey', message: secret.apiKey}).status, 'failed');
});

test('PixVerse 采用 API-KEY、独立 trace ID 与数字状态，不能误解析为 Bearer / OpenAI', () => {
  const connection = connect('pixverse');
  const request = build(connection, 'video.create', {prompt: 'test', traceId, duration: 5, quality: '720p'}, secret);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers['API-KEY'], secret.apiKey);
  assert.equal(request.headers['Ai-trace-id'], traceId);
  assert(!('traceId' in request.body!));
  assert.throws(() => build(connection, 'video.create', {prompt: 'test'}, secret), /traceId/);
  assert.deepEqual(parse(connection, 'video.create', {ErrCode: 0, Resp: {video_id: 123, credits: 5}}), {status: 'submitted', taskId: '123', usage: {credits: 5}});
  for (const [status, expected] of [[5, 'running'], [7, 'failed'], [8, 'failed'], [3, 'unknown']] as const) assert.equal(parse(connection, 'video.status', {ErrCode: 0, Resp: {id: 123, status}}).status, expected);
  assert.equal(parse(connection, 'video.status', {ErrCode: 0, Resp: {id: 123, status: 1}}).status, 'unknown');
  assert.equal(parse(connection, 'video.status', {ErrCode: 12, ErrMsg: secret.apiKey}).status, 'failed');
});

test('响应不返回上游整包、请求头或不可信 URL，unsafe numeric ID 不被截断采纳', () => {
  const source = {id: Number.MAX_SAFE_INTEGER + 1, status: 'succeeded', content: {video_url: 'file:///C:/private'}, headers: {authorization: secret.apiKey}, error_message: secret.apiKey};
  const result = parse(connect('volcengine-ark'), 'video.status', source);
  assert.deepEqual(result, {status: 'unknown'});
  assert.equal(parse(connect('minimax-video-v2'), 'video.create', {}).status, 'unknown');
  assert.deepEqual(parse(connect('deepseek-api'), 'chat', {choices: [{message: {tool_calls: [{id: 'call-1', function: {name: 'image_generate', arguments: '{}'}}]}}], secret: secret.apiKey}), {status: 'succeeded', toolCalls: [{id: 'call-1', name: 'image_generate', arguments: '{}'}]});
});
