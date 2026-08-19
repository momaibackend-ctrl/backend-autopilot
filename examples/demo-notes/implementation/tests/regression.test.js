import test from 'node:test';import assert from 'node:assert/strict';import { NotesService } from '../src/notes.js';import { fakeDb } from './helpers.js';
test('empty title remains invalid',async()=>{await assert.rejects(()=>new NotesService(fakeDb()).create('u1',{title:' '}),e=>e.code==='VALIDATION_ERROR');});
