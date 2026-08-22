import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('vitest regression suite',()=>{const r=spawnSync('pnpm',['exec','vitest','run','tests/unit','tests/integration','tests/security'],{stdio:'inherit'});assert.equal(r.status,0);});
