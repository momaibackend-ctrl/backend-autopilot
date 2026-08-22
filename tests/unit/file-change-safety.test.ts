import { describe, expect, it } from 'vitest';
import { hasRawCredentialMaterial } from '../../packages/execution-engine/src/index.js';

describe('file change credential safety',()=>{
  it('allows safe variable references and environment lookup helpers',()=>{
    const variable=['github','Token'].join('');
    const lookup=['AUTOPILOT_GITHUB_','TOKEN'].join('');
    expect(hasRawCredentialMaterial('scripts/example.ts',`const ${variable}=required('${lookup}');`)).toBe(false);
    expect(hasRawCredentialMaterial('scripts/example.ts',"const serviceCredential = process.env['SERVICE_CREDENTIAL'];")).toBe(false);
  });

  it('allows placeholder-only environment templates',()=>{
    expect(hasRawCredentialMaterial('.env.example','DATABASE_URL=<required>\nSERVICE_CREDENTIAL=placeholder\n')).toBe(false);
  });

  it('rejects real environment files',()=>{
    expect(hasRawCredentialMaterial('.env','SAFE_NAME=<required>')).toBe(true);
  });

  it('rejects known credential prefixes without embedding one in source',()=>{
    const value=['gh','p_','abcdefghijklmnop'].join('');
    expect(hasRawCredentialMaterial('src/example.ts',`const credential = '${value}'`)).toBe(true);
  });

  it('rejects quoted hard-coded sensitive assignments',()=>{
    const key=['pass','word'].join('');
    const source=`const ${key} = '${'not-a-placeholder-value'}'`;
    expect(hasRawCredentialMaterial('src/example.ts',source)).toBe(true);
  });
});
