// The bridge exposes the existing service contract, not credentials or configuration writes.
// The backend derives the project and Agent from the current workgroup job capability.
const string = {type: 'string'};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({type: 'object' as const, properties, required, additionalProperties: false});
export const WORKGROUP_EXTERNAL_TOOL_DEFINITIONS = [
  {name: 'list_external_services', description: '发现本群项目和本人已获准的外部 API、CLI、MCP 服务；不读取密钥或发起生成。', inputSchema: object({project_id: string})},
  {name: 'get_external_calling', description: '读取已获准连接的具体操作、参数和能力限制。', inputSchema: object({service_id: string, project_id: string}, ['service_id'])},
  {name: 'invoke_external_service', description: '通过已配置的外部服务调用；仍按连接的项目、Agent、消费开关及额度限制执行，UUID 幂等。', inputSchema: object({service_id: string, operation: string, input: {type: 'object', additionalProperties: true}, request_id: {type: 'string', format: 'uuid'}, project_id: string}, ['service_id', 'operation', 'request_id'])},
  {name: 'get_external_invocation', description: '查询本群成员已经发起的外部调用；异步任务不能重复创建。', inputSchema: object({invocation_id: string}, ['invocation_id'])},
  {name: 'get_external_artifact', description: '取得本群成员外部调用已落盘的产物位置与校验信息。', inputSchema: object({invocation_id: string, artifact_id: string}, ['invocation_id', 'artifact_id'])},
];
