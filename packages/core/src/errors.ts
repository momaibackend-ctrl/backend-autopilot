export type ErrorCode = 'POLICY_VIOLATION'|'UNKNOWN_RESOURCE'|'DEPENDENCY_BLOCKED'|'ARCHITECTURE_VIOLATION'|'EXECUTION_FAILED'|'TEST_FAILED'|'REVIEW_FAILED'|'CREDENTIAL_MISSING'|'HUMAN_ACTION_REQUIRED'|'NOT_SUPPORTED'|'NOT_FOUND'|'INVALID_STATE'|'CONFLICT';

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message); this.name = new.target.name;
  }
}
export class PolicyViolation extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('POLICY_VIOLATION',message,details);} }
export class UnknownResource extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('UNKNOWN_RESOURCE',message,details);} }
export class DependencyBlocked extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('DEPENDENCY_BLOCKED',message,details);} }
export class ArchitectureViolation extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('ARCHITECTURE_VIOLATION',message,details);} }
export class ExecutionFailed extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('EXECUTION_FAILED',message,details);} }
export class TestFailed extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('TEST_FAILED',message,details);} }
export class ReviewFailed extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('REVIEW_FAILED',message,details);} }
export class CredentialMissing extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('CREDENTIAL_MISSING',message,details);} }
export class HumanActionRequired extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('HUMAN_ACTION_REQUIRED',message,details);} }
export class UnsupportedOperation extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('NOT_SUPPORTED',message,details);} }
export class NotFound extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('NOT_FOUND',message,details);} }
export class InvalidState extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('INVALID_STATE',message,details);} }
export class Conflict extends DomainError { constructor(message:string,details:Record<string,unknown>={}){super('CONFLICT',message,details);} }
