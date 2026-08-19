import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';
test('migration is reproducible and has rollback information',async()=>{const sql=await readFile('migrations/001_notes.sql','utf8');assert.match(sql,/CREATE TABLE IF NOT EXISTS notes/);assert.match(sql,/owner_id uuid NOT NULL/);assert.match(sql,/Rollback:/);});
