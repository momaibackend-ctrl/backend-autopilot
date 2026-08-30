import type { RepositoryRef } from '../../schemas/src/index.js';

/**
 * What the control plane needs to know about a Git host to plan and verify canonical promotion
 * and repository export, expressed provider-neutrally so Core never imports a provider type.
 *
 * Every method takes the repository as `owner/name` resolved from a REGISTERED resource's
 * externalReference. There is deliberately no method that accepts a URL: a caller-supplied Git URL
 * is exactly the escape hatch this whole feature must not have.
 */
export interface RepositoryDescription {
  /** Identity as the provider itself reports it, so a registration that drifted is detectable. */
  externalReference:string;
  /**
   * The provider's STABLE object id, which survives a rename. This is what makes "the registration
   * followed a rename" distinguishable from "the registration was re-pointed at a different
   * repository" -- the second is the failure the GitHub rebinding guard exists to prevent.
   */
  repositoryId:string;
  defaultBranch:string;
  isEmpty:boolean;
  visibility:string;
  /** Effective permissions of the credential the control plane actually holds. */
  permissions:{pull:boolean;push:boolean;admin:boolean};
  protectedBranches:string[];
}

export interface GitRepositoryProvider {
  describe(repository:string):Promise<RepositoryDescription>;
  /** Exact commit a branch/tag currently points at, or undefined when the ref does not exist. */
  resolveRef(repository:string,ref:string):Promise<string|undefined>;
  /** Whether a commit object exists and is reachable in this repository. */
  commitExists(repository:string,sha:string):Promise<boolean>;
  listRefs(repository:string):Promise<{branches:RepositoryRef[];tags:RepositoryRef[]}>;
  /** File content at a ref, or undefined when the path does not exist. Never throws on 404. */
  readFile(repository:string,path:string,ref?:string):Promise<string|undefined>;
  /** Entry paths in a directory at a ref, or undefined when the directory does not exist. */
  listDirectory(repository:string,path:string,ref?:string):Promise<string[]|undefined>;
  /**
   * Renames the repository in place, keeping its id, history, refs, issues and pull requests.
   * Takes the new NAME only: an owner is never accepted, so a rename cannot move a repository
   * between accounts or organizations.
   */
  rename(repository:string,newName:string):Promise<RepositoryDescription>;
  /** Whether a repository exists at all, used to refuse a rename onto an occupied name. */
  exists(repository:string):Promise<boolean>;
}

/** Starts the fixed control-repository workflow that performs a Git-level transfer. */
export interface RepositoryExportDispatcher {
  dispatchWorkflow(workflow:string,inputs:Record<string,string>):Promise<unknown>;
}
