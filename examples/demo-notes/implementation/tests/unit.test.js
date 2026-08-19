import test from 'node:test';import assert from 'node:assert/strict';import { NotesService } from '../src/notes.js';import { fakeDb } from './helpers.js';
test('creates a note for authenticated owner',async()=>{const db=fakeDb();const note=await new NotesService(db).create('u1',{title:'Hello'});assert.equal(note.owner_id,'u1');assert.deepEqual(db.calls[0].args,['u1','Hello','']);});
