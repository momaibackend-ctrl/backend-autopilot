// The Supabase CLI asset scanner follows explicit TypeScript specifiers while
// the import map resolves the NodeNext `.js` specifiers used by shared code.
// Keeping this list here packages the domain graph without maintaining a fork.
import '../../../packages/schemas/src/index.ts';
import '../../../packages/core/src/errors.ts';
import '../../../packages/core/src/ports.ts';
import '../../../packages/core/src/branch.ts';
import '../../../packages/core/src/async-execution.ts';
import '../../../packages/core/src/repository-guard.ts';
import '../../../packages/secret-scanner/src/index.ts';
import '../../../packages/audit/src/index.ts';
import '../../../packages/artifact-store/src/index.ts';
import '../../../packages/policy-engine/src/index.ts';
import '../../../packages/http-runner/src/index.ts';
import '../../../packages/superadmin/src/rebase-eligibility.ts';
import '../../../packages/policy-engine/src/architecture-guard.ts';
import '../../../packages/workflow-engine/src/index.ts';
import '../../../packages/context-engine/src/index.ts';
import '../../../packages/execution-engine/src/reviewer.ts';
import '../../../packages/operator-console/src/delivery.ts';
import '../../../packages/operator-console/src/projections.ts';
import '../../../packages/core/src/task-readiness.ts';
import '../../../packages/core/src/verification-profile.ts';
import '../../../packages/core/src/scope-classification.ts';
import '../../../packages/core/src/epic-verification.ts';
import '../../../packages/canonical-repository/src/index.ts';
import '../../../packages/canonical-repository/src/ports.ts';
import '../../../packages/canonical-repository/src/promotion.ts';
import '../../../packages/canonical-repository/src/export.ts';
import '../../../packages/canonical-repository/src/handover.ts';
import '../../../packages/canonical-repository/src/target-resolution.ts';
import '../../../packages/canonical-repository/src/service.ts';
import '../../../packages/adapters/github/src/repository-provider.ts';
