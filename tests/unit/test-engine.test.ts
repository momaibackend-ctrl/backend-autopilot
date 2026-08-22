import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestEngine } from '../../packages/execution-engine/src/test-engine.js';

const clock={now:()=> '2026-08-22T00:00:00.000Z'};

describe('TestEngine',()=>{
  it('uses declared package test scripts for monorepos instead of requiring legacy flat test files',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'test-engine-scripts-'));
    await writeFile(join(workspace,'package.json'),JSON.stringify({scripts:{'test:unit':'vitest run tests/unit','test':'vitest run'}}));
    const calls:Array<{command:string;args:string[]}>=[];
    const commands={run:async(input:{command:string;args:string[]})=>{calls.push({command:input.command,args:input.args});return {record:{command:[input.command,...input.args],exitCode:0},stdout:'',stderr:''};}};
    const report=await new TestEngine(commands as never,clock as never).run(workspace,'task',{testsRequired:['UNIT','REGRESSION']} as never);
    expect(report.passed).toBe(true);
    expect(calls).toEqual([{command:'pnpm',args:['run','test:unit']},{command:'pnpm',args:['test']}]);
  });

  it('preserves legacy node --test fallback when package scripts are absent',async()=>{
    const workspace=await mkdtemp(join(tmpdir(),'test-engine-legacy-'));
    await mkdir(join(workspace,'tests'));
    await writeFile(join(workspace,'tests','unit.test.js'),'');
    const calls:Array<{command:string;args:string[]}>=[];
    const commands={run:async(input:{command:string;args:string[]})=>{calls.push({command:input.command,args:input.args});return {record:{command:[input.command,...input.args],exitCode:0},stdout:'',stderr:''};}};
    const report=await new TestEngine(commands as never,clock as never).run(workspace,'task',{testsRequired:['UNIT']} as never);
    expect(report.passed).toBe(true);
    expect(calls).toEqual([{command:'node',args:['--test','tests/unit.test.js']}]);
  });
});
