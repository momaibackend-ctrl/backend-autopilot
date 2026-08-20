import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  artifactSchema,
  auditEventSchema,
  projectContextSchema,
  projectSchema,
  resourceSchema,
  runSchema,
  taskSchema,
  transitionSchema,
} from '../packages/schemas/src/index.js';

export const deploymentSnapshotSchema = z.object({
  projects:z.array(projectSchema),
  resources:z.array(resourceSchema),
  contexts:z.array(projectContextSchema),
  tasks:z.array(taskSchema),
  artifacts:z.array(artifactSchema),
  runs:z.array(runSchema),
  transitions:z.array(transitionSchema),
  audit:z.array(auditEventSchema),
});
export type DeploymentSnapshot = z.infer<typeof deploymentSnapshotSchema>;

const workspacePlaceholder = '${AUTOPILOT_WORKSPACE_ROOT}';
const credentialPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sbp_[A-Za-z0-9_-]{20,}/,
  /\bBearer\s+(?!\[REDACTED\])\S+/i,
  /postgres(?:ql)?:\/\/[^:\s/]+:(?!\[REDACTED\])[^@\s/]+@/i,
];

export async function readDeploymentSnapshot(path:string) {
  return deploymentSnapshotSchema.parse(JSON.parse(await readFile(path,'utf8')));
}

export function makePortableSnapshot(snapshot:DeploymentSnapshot):DeploymentSnapshot {
  const byProject = new Map(snapshot.projects.map(project=>[project.id,`${workspacePlaceholder}/${project.slug}`]));
  const portable:DeploymentSnapshot = {
    ...snapshot,
    projects:snapshot.projects.map(project=>({...project,workspacePath:byProject.get(project.id)!})),
    resources:snapshot.resources.map(resource=>resource.type==='GIT_REPOSITORY'&&resource.provider==='local'
      ? {...resource,externalReference:byProject.get(resource.projectId)!}
      : resource),
  };
  assertSecretFree(portable);
  return deploymentSnapshotSchema.parse(portable);
}

export function materializeSnapshot(snapshot:DeploymentSnapshot,workspaceRoot:string):DeploymentSnapshot {
  const absoluteRoot=resolve(workspaceRoot);
  const byProject = new Map(snapshot.projects.map(project=>[project.id,resolve(absoluteRoot,project.slug)]));
  return deploymentSnapshotSchema.parse({
    ...snapshot,
    projects:snapshot.projects.map(project=>({...project,workspacePath:byProject.get(project.id)!})),
    resources:snapshot.resources.map(resource=>resource.type==='GIT_REPOSITORY'&&resource.provider==='local'
      ? {...resource,externalReference:byProject.get(resource.projectId)!}
      : resource),
  });
}

export function assertSecretFree(value:unknown) {
  const serialized=JSON.stringify(value);
  if (credentialPatterns.some(pattern=>pattern.test(serialized))) {
    throw new Error('Deployment state contains credential-shaped data and will not be exported');
  }
}
