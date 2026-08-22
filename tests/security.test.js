import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('vitest security suite',()=>{const r=spawnSync('pnpm',['exec','vitest','run','tests/security'],{stdio:'inherit'});assert.equal(r.status,0);});
