import test from 'node:test';import assert from 'node:assert/strict';import { NotesService } from '../src/notes.js';import { fakeDb } from './helpers.js';
test('all reads are scoped by owner',async()=>{const db=fakeDb();await new NotesService(db).get('u1','n1');assert.match(db.calls[0].sql,/id=\$1 AND owner_id=\$2/);assert.deepEqual(db.calls[0].args,['n1','u1']);});
