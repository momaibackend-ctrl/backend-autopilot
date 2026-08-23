// The Supabase CLI asset scanner follows explicit TypeScript specifiers while
// the import map resolves the NodeNext `.js` specifiers used by shared code.
// Keeping this list here packages the domain graph without maintaining a fork.
import '../../../packages/schemas/src/index.ts';
import '../../../packages/core/src/errors.ts';
import '../../../packages/core/src/ports.ts';
import '../../../packages/core/src/branch.ts';
import '../../../packages/core/src/async-execution.ts';
import '../../../packages/audit/src/index.ts';
import '../../../packages/artifact-store/src/index.ts';
import '../../../packages/policy-engine/src/index.ts';
import '../../../packages/http-runner/src/index.ts';
import '../../../packages/superadmin/src/rebase-eligibility.ts';
import '../../../packages/policy-engine/src/architecture-guard.ts';
import '../../../packages/workflow-engine/src/index.ts';
import '../../../packages/context-engine/src/index.ts';
import '../../../packages/execution-engine/src/reviewer.ts';
