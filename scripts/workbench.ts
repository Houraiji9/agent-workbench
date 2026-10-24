// A programmatic entry for local Agents without a preconfigured MCP connection.
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ROOT} from '../src/core/config.ts';

const [action,name,file]=process.argv.slice(2);
if(!['tools','context','call'].includes(action)||action==='call'&&(!name||!file)){
  console.error('用法：workbench tools | context | call <工具名> <JSON 文件或 ->');process.exitCode=1;
}else{
  const client=new Client({name:'workbench-local-management',version:'1'});
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
    const transport=new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env,stderr:'pipe'});
    // Only this project's MCP emits stderr; never dump credential files.
    transport.stderr?.on('data',chunk=>process.stderr.write(chunk));
    await client.connect(transport);
    if(action==='tools')console.log(JSON.stringify(await client.listTools(),null,2));
    else{
      let input:unknown={};
      if(action==='call'){
        if(file!=='-'){if(fs.statSync(file).size>2*1024*1024)throw Error('输入文件超过 2 MiB');input=JSON.parse(fs.readFileSync(file,'utf8'))}
        else{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw Error('输入超过 2 MiB')}input=JSON.parse(raw)}
      }
      const result=await client.callTool({name:action==='context'?'get_management_context':name,arguments:input as Record<string,unknown>},undefined,{timeout:180000});
      for(const block of result.content as {type:string;text?:string}[])if(block.type==='text')console.log(block.text);
      if(result.isError)process.exitCode=1;
    }
  }catch(error){console.error(error instanceof Error?error.message:'工作台调用失败');process.exitCode=1}
  finally{await client.close()}
}
