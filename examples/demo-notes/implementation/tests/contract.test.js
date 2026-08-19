import test from 'node:test';import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';
test('OpenAPI exposes CRUD and auth',async()=>{const api=JSON.parse(await readFile('openapi.json','utf8'));assert.equal(api.openapi,'3.1.0');assert.ok(api.paths['/notes'].post);assert.ok(api.paths['/notes/{id}'].delete);assert.ok(api.components.securitySchemes.userId);});
