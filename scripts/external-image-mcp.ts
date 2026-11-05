import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {callImageBackend, readImageBridgeCredential, type ExternalImageTool, type ImageBridgeCredential} from '../src/core/harness-image-tools.ts';

type BackendCall = (tool: ExternalImageTool, input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
const id = z.string().trim().min(1).max(160);
const imageReference = z.object({image_url: z.string().min(1).max(24 * 1024 * 1024)}).strict();
const request = {service_id: id, request_id: z.string().uuid(), prompt: z.string().trim().min(1).max(32000), options: z.record(z.unknown()).optional()};
const textResult = (result: unknown) => ({content: [{type: 'text' as const, text: JSON.stringify(result, null, 2)}]});
const safeFailure = (error: unknown) => ({content: [{type: 'text' as const, text: error instanceof Error ? error.message : '生图服务调用失败；未自动重试'}], isError: true});
export function imageArtifactResult(value: Record<string, unknown>) {
  const {inline_image, ...metadata} = value;
  const result: {content: Array<{type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string}>} = textResult(metadata);
  // Only bytes provided by the authorized artifact endpoint are projected. Never read
  // a model-supplied or backend-returned filesystem path in this bridge process.
  const preview = inline_image as {mime_type?: unknown; data?: unknown} | undefined;
  if (preview && typeof preview.mime_type === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(preview.mime_type) && typeof preview.data === 'string' && preview.data.length > 0 && preview.data.length <= 11 * 1024 * 1024 && preview.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.data) && Buffer.from(preview.data, 'base64').length <= 8 * 1024 * 1024) {
    result.content.push({type: 'image', data: preview.data, mimeType: preview.mime_type});
  }
  return result;
}
export function createExternalImageServer(call: BackendCall) {
  const server = new McpServer({name: 'agent-workbench-images', version: '1.0.0'}, {instructions: '工作台托管的生图工具。先查看已配置服务；生成或编辑会按服务消耗额度，遵守当前用户授权。每次新请求提供唯一 request_id；重试同一次请求必须复用原编号。提交后通过查询工具读取状态和已落盘产物，不重复提交。'});
  server.registerTool('list_image_services', {description: '读取已配置的图像服务与能力，不调用模型、不生成图片、不收费。', inputSchema: {}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true}}, async (_input, extra) => {
    try {
      const value = await call('list_external_services', {}, extra.signal);
      const source = Array.isArray(value.services) ? value.services : Array.isArray(value.connections) ? value.connections : [];
      const services = source.filter((s: any) => Array.isArray(s.operations) && s.operations.some((operation: unknown) => ['generate_image', 'edit_image', 'image.generate', 'image.edit'].includes(String(operation))));
      return textResult({services});
    } catch (error) { return safeFailure(error); }
  });
  const submit = async (operation: 'generate_image' | 'edit_image', input: {service_id: string; request_id: string; prompt: string; options?: Record<string, unknown>; images?: Array<{image_url: string}>}, signal?: AbortSignal) => {
    if (input.options && ['prompt', 'images', 'api_key', 'apiKey', 'token', 'authorization', 'base_url', 'baseURL'].some(key => key in input.options!)) throw Error('options 不能覆盖提示词、图片或连接凭据；请在工作台配置服务');
    return textResult(await call('invoke_external_service', {service_id: input.service_id, request_id: input.request_id, operation, input: {...input.options, prompt: input.prompt, ...(input.images ? {images: input.images} : {})}}, signal));
  };
  server.registerTool('generate_image', {description: '使用工作台已配置服务生成图片。可能收费；request_id 是本次操作的幂等编号，重试复用。返回调用状态，异步任务用 get_image_invocation 查询。', inputSchema: request, annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true}}, async (input, extra) => {
    try { return await submit('generate_image', input, extra.signal); } catch (error) { return safeFailure(error); }
  });
  server.registerTool('edit_image', {description: '使用工作台已配置服务编辑图片。images 为 image_url 引用，可为提供方支持的 URL、data URL 或项目授权本地路径，由后台校验。可能收费，重试复用 request_id。', inputSchema: {...request, images: z.array(imageReference).min(1).max(16)}, annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true}}, async (input, extra) => {
    try { return await submit('edit_image', input, extra.signal); } catch (error) { return safeFailure(error); }
  });
  server.registerTool('get_image_invocation', {description: '查询本生图桥创建的调用状态和产物，不重新提交生成请求。', inputSchema: {invocation_id: id}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true}}, async (input, extra) => {
    try { return textResult(await call('get_external_invocation', input, extra.signal)); } catch (error) { return safeFailure(error); }
  });
  server.registerTool('get_image_artifact', {description: '取得本生图桥调用的已落盘产物路径、类型及可用预览。不能读取任意文件路径。', inputSchema: {invocation_id: id, artifact_id: id}, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true}}, async (input, extra) => {
    try { return imageArtifactResult(await call('get_external_artifact', input, extra.signal)); } catch (error) { return safeFailure(error); }
  });
  return server;
}
export async function startExternalImageServer(credentialFile: string) {
  // Read/decrypt lazily: MCP initialize/tools-list has no network, model, or credential
  // side effects, including Harness's temporary protocol-negotiation process.
  const call: BackendCall = async (tool, input, signal) => {
    const credential: ImageBridgeCredential = await readImageBridgeCredential(credentialFile);
    return callImageBackend(credential, tool, input, signal);
  };
  const server = createExternalImageServer(call);
  await server.connect(new StdioServerTransport());
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const credentialFile = process.env.WORKBENCH_EXTERNAL_TOOLS_CREDENTIAL_FILE;
  if (!credentialFile) { console.error('缺少工作台受限生图凭据文件引用'); process.exitCode = 1; }
  else startExternalImageServer(credentialFile).catch(() => { console.error('工作台生图工具无法启动；请核对本机安装'); process.exitCode = 1; });
}
