import { afterAll,describe,expect,it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','apps/mcp-server/src/main.ts'],env:{...env,AUTOPILOT_STORE:'memory'}});
const client=new Client({name:'backend-autopilot-integration-test',version:'0.1.0'});
afterAll(async()=>{await client.close();});
describe('MCP server',()=>{it('starts, exposes semantic tools, and serves health',async()=>{await client.connect(transport);const tools=await client.listTools();expect(tools.tools.map(t=>t.name)).toContain('task_execute');expect(tools.tools.map(t=>t.name)).not.toContain('run_any_command');expect(tools.tools).toHaveLength(24);const response=await client.callTool({name:'system_health',arguments:{}});expect(response.isError).not.toBe(true);expect(JSON.stringify(response.content)).toContain('0.1.0');});});
