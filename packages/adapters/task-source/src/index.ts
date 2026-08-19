import { readFile } from 'node:fs/promises';
import type { TaskSourceSnapshot } from '../../../schemas/src/index.js';
import { taskSourceSnapshotSchema } from '../../../schemas/src/index.js';

export interface TaskSourceAdapter {load():Promise<TaskSourceSnapshot>;}
export class JsonFixtureTaskSource implements TaskSourceAdapter {constructor(private data:unknown){}async load(){return taskSourceSnapshotSchema.parse(this.data);}}
export class LocalFilesystemTaskSource implements TaskSourceAdapter {constructor(private path:string){}async load(){return taskSourceSnapshotSchema.parse(JSON.parse(await readFile(this.path,'utf8')));}}
export class MockTaskSource extends JsonFixtureTaskSource {}
// Future qira-adapter implements TaskSourceAdapter. Core intentionally has no Qira dependency.
