"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { authorizedFetch } from "./lib/supabase";

type Json = Record<string, unknown>;
type ProjectCard = {
  id: string;
  name: string;
  environment: string;
  autonomyMode: string;
  status: string;
  repository?: string;
  databaseProvider?: string;
  databaseProject?: string;
  taskSource: string;
  createdAt: string;
  lastActivity?: string;
  tasks: Task[];
  runs: Run[];
  latestCi?: unknown;
  warningCount: number;
  recentEvents: Audit[];
};
type Task = {
  id: string;
  projectId: string;
  externalKey: string;
  title: string;
  state: string;
  repairAttempts: number;
  requirements?: string[];
  artifactCount?: number;
  branch?: string;
  commitSha?: string;
  ci?: unknown;
  review?: unknown;
  warnings?: unknown[];
};
type Run = {
  id: string;
  taskId: string;
  operationId: string;
  status: string;
  branch?: string;
  commitSha?: string;
  startedAt: string;
  finishedAt?: string;
};
type Artifact = {
  id: string;
  projectId: string;
  taskId?: string;
  runId?: string;
  kind: string;
  content: unknown;
  createdAt: string;
};
type Audit = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  projectId: string;
  taskId?: string;
  resourceId?: string;
  reason: string;
  result: unknown;
};
type DeliverySuite = { type: string; passed: boolean; exitCode?: number };
type DeliveryGate = "PASS" | "FAIL" | "PENDING";
type DeliveryRecord = {
  taskId: string;
  externalKey: string;
  sourceRef?: string;
  sourceRefDerived: boolean;
  title: string;
  state: string;
  repairAttempts: number;
  branch?: string;
  commitSha?: string;
  attempts: number;
  failedAttempts: number;
  tests: { status: DeliveryGate; suites: DeliverySuite[]; finishedAt?: string };
  ci: { status: DeliveryGate; conclusion?: string; url?: string; headSha?: string; stack?: string; toolchain?: Record<string, unknown> };
  review: { status: DeliveryGate; failures: string[]; warnings: number; reviewedAt?: string };
  verifiedCommitSha?: string;
  pullRequest?: { number: number; url: string };
  merged: boolean;
  mergedIntoBranch?: string;
  mergedCommitSha?: string;
  rebaseStatus?: string;
  startedAt?: string;
  completedAt?: string;
};
type DeliveryView = {
  summary: { total: number; merged: number; ready: number; inFlight: number; blocked: number; failed: number; testsPassing: number; reviewPassing: number };
  records: DeliveryRecord[];
};
type Overview = {
  generatedAt: string;
  summary: {
    projects: number;
    activeTasks: number;
    blocked: number;
    failed: number;
    ready: number;
    runningRuns: number;
    warnings: number;
  };
  projects: ProjectCard[];
  events: Audit[];
};
type ScreenBlock=
  | {id:string;type:"TEXT";title:string;content:string}
  | {id:string;type:"METRIC";title:string;value:string|number|boolean;note:string}
  | {id:string;type:"JSON";title:string;value:unknown};
type ScreenConfig={screenId:string;title:string;description:string;enabled:boolean;blocks:ScreenBlock[]};
const api = "/v1/console";
function usePolling<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await authorizedFetch(`${api}${path}`, { cache: "no-store" });
      const value = (await response.json()) as
        | T
        | { error: { message: string } };
      if (!response.ok) {
        const message =
          typeof value === "object" && value !== null && "error" in value
            ? value.error.message
            : "Request failed";
        throw new Error(message);
      }
      setData(value as T);
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Console unavailable");
    }
  }, [path]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);
  return { data, error, reload: load };
}
export function ConsoleSection({ section }: { section: string }) {
  const { data, error, reload } = usePolling<Overview>("/overview");
  const screen = useOptionalScreen(section.toLowerCase());
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return <Loading />;
  const normalized = section.toLowerCase();
  return (
    <div className="page">
      <Title title={screen?.title??label(normalized)} subtitle={screen?.description??subtitle(normalized)} />
      {screen&&<ConfiguredBlocks blocks={screen.blocks}/>}
      {normalized === "dashboard" && <Dashboard data={data} />}{" "}
      {normalized === "projects" && <Projects projects={data.projects} />}{" "}
      {normalized === "tasks" && <Tasks projects={data.projects} />}{" "}
      {normalized === "delivery" && <Delivery projects={data.projects} />}{" "}
      {normalized === "runs" && <Runs projects={data.projects} />}{" "}
      {normalized === "validation" && <Validation projects={data.projects} />}{" "}
      {normalized === "api-explorer" && <GlobalApiExplorer projects={data.projects} />}{" "}
      {normalized === "database" && <GlobalDatabase projects={data.projects} />}{" "}
      {normalized === "infrastructure" && (
        <Infrastructure projects={data.projects} />
      )}{" "}
      {normalized === "artifacts" && <Artifacts projects={data.projects} />}{" "}
      {normalized === "audit" && <AuditView projects={data.projects} />}{" "}
      {normalized === "capabilities" && (
        <Capabilities projects={data.projects} />
      )}{" "}
      {normalized === "settings" && <Settings />}
    </div>
  );
}
function useOptionalScreen(screenId:string){const [value,setValue]=useState<ScreenConfig>();useEffect(()=>{let active=true;const load=()=>authorizedFetch(`${api}/screens/${screenId}`,{cache:"no-store"}).then(async response=>{if(response.ok&&active)setValue(await response.json() as ScreenConfig);}).catch(()=>undefined);void load();const timer=setInterval(()=>void load(),5_000);return()=>{active=false;clearInterval(timer);};},[screenId]);return value;}
function ConfiguredBlocks({blocks}:{blocks:ScreenBlock[]}){if(!blocks.length)return null;return <div className="configuredBlocks">{blocks.map(block=>block.type==="TEXT"?<Panel key={block.id} title={block.title}><p>{block.content}</p></Panel>:block.type==="METRIC"?<div className="metric" key={block.id}><span>{block.title}</span><strong>{String(block.value)}</strong><small>{block.note}</small></div>:<Panel key={block.id} title={block.title}><JsonView value={block.value}/></Panel>)}</div>;}
function Dashboard({ data }: { data: Overview }) {
  const providerCount = new Set(
    data.projects.flatMap((project) =>
      [project.repository ? "Git" : undefined, project.databaseProvider].filter(
        Boolean,
      ),
    ),
  ).size;
  const infrastructureIssues = data.projects.filter(
    (project) => !project.repository || !project.databaseProvider,
  ).length;
  const cards = [
    ["Projects", data.summary.projects, "registered"],
    ["Active tasks", data.summary.activeTasks, "in progress"],
    ["Ready", data.summary.ready, "formal gates passed"],
    ["Blocked", data.summary.blocked, "needs attention"],
    ["Failed", data.summary.failed, "not ready"],
    ["Running", data.summary.runningRuns, "execution runs"],
    ["Warnings", data.summary.warnings, "unresolved"],
    ["Infrastructure", infrastructureIssues, "projects need attention"],
    ["Providers", providerCount, "connected types"],
  ];
  return (
    <>
      <div className="metrics">
        {cards.map(([name, value, note]) => (
          <div className="metric" key={name}>
            <span>{name}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <div className="grid two">
        <Panel title="Projects">
          <Projects projects={data.projects} compact />
        </Panel>
        <Panel title="Recent significant events">
          <Timeline events={data.events} />
        </Panel>
      </div>
      <Panel title="Provider and CI status">
        <Table
          headers={[
            "Project",
            "Git / GitHub",
            "Latest CI",
            "Database",
            "Environment",
          ]}
          rows={data.projects.map((project) => [
            project.name,
            project.repository ?? "Not connected",
            <Badge key="ci" value={latestCiStatus(project.latestCi)} />,
            project.databaseProvider ?? "Not connected",
            project.environment,
          ])}
        />
      </Panel>
    </>
  );
}
function Projects({
  projects,
  compact = false,
}: {
  projects: ProjectCard[];
  compact?: boolean;
}) {
  return (
    <div className={compact ? "stack" : "projectGrid"}>
      {projects.map((project) => (
        <Link
          className="projectCard"
          href={`/projects?projectId=${encodeURIComponent(project.id)}`}
          key={project.id}
        >
          <div className="row between">
            <strong>{project.name}</strong>
            <Badge value={project.status} />
          </div>
          <p>{project.repository ?? "Local workspace"} </p>
          <div className="meta">
            <span>{project.environment}</span>
            <span>{project.autonomyMode.replaceAll("_", " ")}</span>
            <span>{project.tasks.length} tasks</span>
          </div>
          {!compact && (
            <dl>
              <dt>Database</dt>
              <dd>{project.databaseProvider ?? "Not connected"}</dd>
              <dt>Last activity</dt>
              <dd>{formatDate(project.lastActivity)}</dd>
            </dl>
          )}
        </Link>
      ))}
    </div>
  );
}
function Tasks({ projects }: { projects: ProjectCard[] }) {
  const tasks = projects.flatMap((project) =>
    project.tasks.map((task) => ({ ...task, projectName: project.name })),
  );
  return (
    <Table
      headers={["Task", "Project", "State", "Branch", "Commit", "Repair"]}
      rows={tasks.map((task) => [
        <Link
          key={task.id}
          href={`/tasks?projectId=${encodeURIComponent(task.projectId)}&taskId=${encodeURIComponent(task.id)}`}
        >
          <strong>{task.externalKey}</strong>
          <small>{task.title}</small>
        </Link>,
        task.projectName,
        <Badge key="s" value={task.state} />,
        task.branch ?? "—",
        short(task.commitSha),
        String(task.repairAttempts),
      ])}
    />
  );
}
// Delivery answers the question the rest of the console does not: for each upstream epic, was it
// actually built, what proved it, and did it reach the repository's default branch. Every field is
// read from durable per-task evidence, so a green row here means artifacts exist to back it.
function Delivery({ projects }: { projects: ProjectCard[] }) {
  return (
    <div className="stack">
      {projects.map((project) => (
        <ProjectDelivery key={project.id} project={project} />
      ))}
      {!projects.length && <Empty text="No projects registered yet." />}
    </div>
  );
}
function ProjectDelivery({ project }: { project: ProjectCard }) {
  const { data, error } = usePolling<DeliveryView>(`/projects/${project.id}/delivery`);
  if (error) return <Panel title={project.name}><Empty text={error} /></Panel>;
  if (!data) return <Panel title={project.name}><Loading small /></Panel>;
  const { summary, records } = data;
  return (
    <section className="panel deliveryPanel">
      <header className="deliveryHead">
        <div>
          <h2>{project.name}</h2>
          <p className="muted">{project.repository ?? "no repository registered"}</p>
        </div>
        <div className="deliveryStats">
          <Stat label="Merged" value={summary.merged} total={summary.total} tone="ok" />
          <Stat label="Ready" value={summary.ready} total={summary.total} tone="info" />
          <Stat label="In flight" value={summary.inFlight} total={summary.total} tone="warn" />
          <Stat label="Blocked / failed" value={summary.blocked + summary.failed} total={summary.total} tone="bad" />
        </div>
      </header>
      {!records.length && <Empty text="No tasks registered for this project." />}
      <div className="deliveryList">
        {records.map((record) => (
          <DeliveryRow key={record.taskId} record={record} projectId={project.id} />
        ))}
      </div>
    </section>
  );
}
function DeliveryRow({ record, projectId }: { record: DeliveryRecord; projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`deliveryRow ${record.merged ? "isMerged" : ""}`}>
      <button className="deliveryMain" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`deliveryChevron ${open ? "isOpen" : ""}`} aria-hidden="true" />
        <span className="deliveryKeys">
          <strong>{record.externalKey}</strong>
          {record.sourceRef && (
            // Parsed from the task text, not a verified tracker link -- the tooltip says so rather
            // than letting the badge imply a guaranteed upstream binding.
            <span className="chip chipSource" title="Parsed from the task title/description; not a verified tracker link">
              {record.sourceRef}
            </span>
          )}
        </span>
        <span className="deliveryTitle">{record.title}</span>
        <span className="deliveryGates">
          <Gate label="Tests" status={record.tests.status} />
          <Gate label="CI" status={record.ci.status} />
          <Gate label="Review" status={record.review.status} />
        </span>
        <Badge value={record.state} />
        <span className={`chip ${record.merged ? "chipOk" : "chipIdle"}`}>
          {record.merged ? `merged → ${record.mergedIntoBranch ?? "main"}` : "not merged"}
        </span>
      </button>
      {open && (
        <div className="deliveryDetail">
          <div className="deliveryGrid">
            <Info label="Branch" value={record.branch ?? "—"} />
            <Info label="Verified commit" value={short(record.verifiedCommitSha ?? record.commitSha)} />
            <Info label="Attempts" value={`${record.attempts} (${record.failedAttempts} failed)`} />
            <Info label="Repair attempts" value={record.repairAttempts} />
            {record.ci.stack && <Info label="Stack" value={record.ci.stack} />}
            {record.rebaseStatus && <Info label="Rebase" value={record.rebaseStatus} />}
            {record.completedAt && <Info label="Completed" value={formatDate(record.completedAt)} />}
          </div>
          <div className="deliverySuites">
            <h4>Test suites</h4>
            {record.tests.suites.length ? (
              <ul className="suiteList">
                {record.tests.suites.map((suite) => (
                  <li key={suite.type} className={suite.passed ? "ok" : "bad"}>
                    <span>{suite.type}</span>
                    <small>{suite.passed ? "passed" : `failed (exit ${suite.exitCode ?? "?"})`}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text="No test report recorded yet." />
            )}
          </div>
          {record.review.status === "FAIL" && record.review.failures.length > 0 && (
            <div className="deliveryFailures">
              <h4>Review blocked on</h4>
              <ul>
                {record.review.failures.map((failure) => (
                  <li key={failure}>{failure}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="deliveryLinks">
            <Link href={`/tasks?projectId=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(record.taskId)}`}>
              Open task detail →
            </Link>
            {record.pullRequest && (
              <a href={record.pullRequest.url} target="_blank" rel="noreferrer">
                Pull request #{record.pullRequest.number} →
              </a>
            )}
            {record.ci.url && (
              <a href={record.ci.url} target="_blank" rel="noreferrer">
                CI run →
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
function Gate({ label, status }: { label: string; status: DeliveryGate }) {
  const mark = status === "PASS" ? "✓" : status === "FAIL" ? "✕" : "•";
  return (
    <span className={`gate gate${status}`} title={`${label}: ${status.toLowerCase()}`}>
      <span aria-hidden="true">{mark}</span>
      {label}
    </span>
  );
}
function Stat({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  return (
    <div className={`stat stat-${tone}`}>
      <strong>{value}</strong>
      <span>
        {label}
        <small>of {total}</small>
      </span>
    </div>
  );
}
function Runs({ projects }: { projects: ProjectCard[] }) {
  const runs = projects
    .flatMap((project) =>
      project.runs.map((run) => ({ ...run, projectName: project.name })),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    <Table
      headers={["Run", "Project", "Status", "Branch", "Commit", "Started"]}
      rows={runs.map((run) => [
        run.operationId,
        run.projectName,
        <Badge key="s" value={run.status} />,
        run.branch ?? "—",
        short(run.commitSha),
        formatDate(run.startedAt),
      ])}
    />
  );
}
function Validation({ projects }: { projects: ProjectCard[] }) {
  const [projectId, setProject] = useState(projects[0]?.id ?? "");
  const selected = projects.find((value) => value.id === projectId);
  const [taskId, setTask] = useState(selected?.tasks[0]?.id ?? "");
  const [suite, setSuite] = useState("FULL");
  const [result, setResult] = useState<Artifact>();
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<Artifact[]>([]);
  const [operationError, setOperationError] = useState("");
  useEffect(
    () =>
      setTask(
        projects.find((value) => value.id === projectId)?.tasks[0]?.id ?? "",
      ),
    [projectId, projects],
  );
  const loadHistory = useCallback(async () => {
    if (!projectId) return;
    const response = await authorizedFetch(`${api}/projects/${projectId}/validation`, {
      cache: "no-store",
    });
    if (response.ok) setHistory((await response.json()) as Artifact[]);
  }, [projectId]);
  useEffect(() => {
    void loadHistory();
    const timer = setInterval(() => void loadHistory(), 5_000);
    return () => clearInterval(timer);
  }, [loadHistory]);
  async function run() {
    if (!projectId || !taskId) return;
    setPending(true);
    setOperationError("");
    const response = await authorizedFetch(`${api}/projects/${projectId}/validation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, suite, operationId: crypto.randomUUID() }),
    });
    const value = (await response.json()) as {
      report?: Artifact;
      error?: { message: string };
    };
    setPending(false);
    if (value.report) {
      setResult(value.report);
      await loadHistory();
    } else setOperationError(value.error?.message ?? "Validation failed");
  }
  async function runScenario(scenarioArtifactId: string) {
    if (!projectId) return;
    setPending(true);
    setOperationError("");
    const response = await authorizedFetch(`${api}/projects/${projectId}/scenarios/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenarioArtifactId,
        operationId: crypto.randomUUID(),
      }),
    });
    const value = (await response.json()) as {
      report?: Artifact;
      error?: { message: string };
    };
    setPending(false);
    if (value.report) {
      setResult(value.report);
      await loadHistory();
    } else setOperationError(value.error?.message ?? "Scenario failed");
  }
  const scenarios = history.filter(
    (artifact) => artifact.kind === "VALIDATION_SCENARIO",
  );
  return (
    <>
      <div className="grid two">
        <Panel title="Run validation suite">
          <p className="muted">
            Проверки выполняются только для зарегистрированного non-production
            проекта. Секреты остаются на сервере.
          </p>
          <div className="form">
            <label>
              Project
              <select
                value={projectId}
                onChange={(event) => setProject(event.target.value)}
              >
                {projects.map((value) => (
                  <option value={value.id} key={value.id}>
                    {value.name} · {value.environment}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Task
              <select
                value={taskId}
                onChange={(event) => setTask(event.target.value)}
              >
                {selected?.tasks.map((value) => (
                  <option value={value.id} key={value.id}>
                    {value.externalKey} · {value.state}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Suite
              <select
                value={suite}
                onChange={(event) => setSuite(event.target.value)}
              >
                {[
                  "SMOKE",
                  "CRUD",
                  "AUTHENTICATION",
                  "AUTHORIZATION",
                  "RLS",
                  "REGRESSION",
                  "FULL",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button onClick={() => void run()} disabled={pending || !taskId}>
              {pending ? "Running…" : "Run validation"}
            </button>
          </div>
          {operationError && (
            <div className="errorState" role="alert">
              <strong>Validation could not complete</strong>
              <p>{operationError}</p>
            </div>
          )}
        </Panel>
        <Panel title="Latest result">
          {result ? (
            <ValidationResult artifact={result} />
          ) : (
            <Empty text="Запустите suite или saved scenario, чтобы получить persisted report." />
          )}
        </Panel>
      </div>
      <div className="grid two">
        <Panel title="Saved API scenarios">
          {scenarios.length ? (
            <div className="stack">
              {scenarios.map((scenario) => {
                const content = scenario.content as Json;
                return (
                  <div className="row between" key={scenario.id}>
                    <span>
                      <strong>{String(content.name)}</strong>
                      <small className="muted">
                        {String((content.steps as unknown[])?.length ?? 0)}{" "}
                        steps
                      </small>
                    </span>
                    <button
                      disabled={pending}
                      onClick={() => void runScenario(scenario.id)}
                    >
                      Run scenario
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty text="No saved scenarios for this project." />
          )}
        </Panel>
        <Panel title="Validation history">
          {history.length ? (
            <ArtifactBrowser artifacts={history} />
          ) : (
            <Empty text="No validation history yet." />
          )}
        </Panel>
      </div>
    </>
  );
}
function Infrastructure({ projects }: { projects: ProjectCard[] }) {
  return (
    <div className="stack">
      {projects.map((project) => (
        <InfrastructureCard key={project.id} project={project} />
      ))}
    </div>
  );
}
function GlobalApiExplorer({projects}:{projects:ProjectCard[]}){return <div className="stack">{projects.map(project=><ProjectApiExplorer key={project.id} project={project}/>)}</div>;}
function ProjectApiExplorer({project}:{project:ProjectCard}){const {data}=usePolling<Json>(`/projects/${project.id}`);if(!data)return <Loading small/>;return <Panel title={project.name}><ApiExplorer api={(data.api??{}) as Json} resources={(data.resources??[]) as Json[]} projectId={project.id} tasks={(data.tasks??[]) as Task[]}/></Panel>;}
function GlobalDatabase({projects}:{projects:ProjectCard[]}){return <div className="stack">{projects.map(project=><ProjectDatabase key={project.id} project={project}/>)}</div>;}
function ProjectDatabase({project}:{project:ProjectCard}){const {data}=usePolling<Json>(`/projects/${project.id}`);return <Panel title={project.name}>{data?<DatabasePanel value={(data.database??{}) as Json}/>:<Loading small/>}</Panel>;}
function InfrastructureCard({ project }: { project: ProjectCard }) {
  const { data } = usePolling<Json>(`/projects/${project.id}`);
  const resources = (data?.resources ?? []) as Json[];
  return (
    <Panel title={project.name}>
      <div className="statusGrid">
        <Info label="Repository" value={project.repository} />
        <Info label="Database" value={project.databaseProvider} />
        <Info label="Database project" value={project.databaseProject} />
        <Info label="Environment" value={project.environment} />
      </div>
      {resources.length ? (
        <Table
          headers={[
            "Allowlisted resource",
            "Provider",
            "Reference",
            "Access",
            "Status",
          ]}
          rows={resources.map((resource) => [
            String(resource.type),
            String(resource.provider),
            String(resource.externalReference),
            Array.isArray(resource.permissions)
              ? resource.permissions.join(", ")
              : "—",
            <Badge key="status" value={String(resource.status)} />,
          ])}
        />
      ) : (
        <Loading small />
      )}
    </Panel>
  );
}
function Artifacts({ projects }: { projects: ProjectCard[] }) {
  return (
    <div className="stack">
      {projects.map((project) => (
        <ProjectArtifacts key={project.id} project={project} />
      ))}
    </div>
  );
}
function ProjectArtifacts({ project }: { project: ProjectCard }) {
  const { data } = usePolling<Json>(`/projects/${project.id}`);
  return (
    <Panel title={project.name}>
      {data ? (
        <ArtifactBrowser artifacts={data.artifacts as Artifact[]} />
      ) : (
        <Loading small />
      )}
    </Panel>
  );
}
function AuditView({ projects }: { projects: ProjectCard[] }) {
  return (
    <div className="stack">
      {projects.map((project) => (
        <ProjectAudit key={project.id} project={project} />
      ))}
    </div>
  );
}
function ProjectAudit({ project }: { project: ProjectCard }) {
  const { data } = usePolling<Json>(`/projects/${project.id}`);
  const [search, setSearch] = useState("");
  const events = ((data?.audit ?? []) as Audit[]).filter((event) =>
    `${event.timestamp} ${event.actor} ${event.action} ${event.taskId ?? ""} ${event.resourceId ?? ""} ${event.reason}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Panel title={project.name}>
      <div className="form filterBar">
        <label>
          Search actor, action, task, resource or reason
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {data ? <Timeline events={events} /> : <Loading small />}
    </Panel>
  );
}
function Capabilities({ projects }: { projects: ProjectCard[] }) {
  return (
    <div className="stack">
      {projects.map((project) => (
        <CapabilityCard
          key={project.id}
          projectId={project.id}
          name={project.name}
        />
      ))}
    </div>
  );
}
function CapabilityCard({
  projectId,
  name,
}: {
  projectId: string;
  name: string;
}) {
  const { data } = usePolling<Json>(`/projects/${projectId}`);
  return (
    <Panel title={name}>
      {data ? (
        <CapabilityTree value={data.capabilities as Json} />
      ) : (
        <Loading small />
      )}
    </Panel>
  );
}
function CapabilityTree({ value }: { value: Json }) {
  const rows = Object.entries(value).flatMap(([group, items]) =>
    typeof items === "object" && items && !Array.isArray(items)
      ? Object.entries(items as Json)
          .filter(
            ([, entry]) =>
              typeof entry === "object" && entry && "status" in (entry as Json),
          )
          .map(([name, entry]) => ({
            name: `${group} · ${name}`,
            entry: entry as Json,
          }))
      : [],
  );
  return (
    <div className="capabilities">
      {rows.map(({ name, entry }) => (
        <div key={name}>
          <span>{name}</span>
          <Badge value={String(entry.status)} />
          <small>{String(entry.detail ?? "")}</small>
        </div>
      ))}
    </div>
  );
}
function Settings() {
  return (
    <div className="grid two">
      <Panel title="Safety posture">
        <ul className="checks">
          <li>Production validation and writes: NOT SUPPORTED</li>
          <li>Browser secrets: never exposed</li>
          <li>Provider calls: server-side only</li>
          <li>External content: rendered as escaped text</li>
        </ul>
      </Panel>
      <Panel title="Future assembly">
        <p>
          DesignSourceAdapter and FrontendTaskSourceAdapter are prepared for
          Figma, frontend repositories, contract synchronization and integrated
          product validation.
        </p>
      </Panel>
    </div>
  );
}
export function ProjectDetail({ projectId }: { projectId: string }) {
  const { data, error, reload } = usePolling<Json>(`/projects/${projectId}`);
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return <Loading />;
  const project = data.project as Json,
    tasks = data.tasks as Task[],
    resources = data.resources as Json[],
    artifacts = data.artifacts as Artifact[],
    audit = data.audit as Audit[];
  return (
    <div className="page">
      <div className="breadcrumbs">
        <Link href="/projects">Projects</Link>
        <span>/</span>
        {String(project.name)}
      </div>
      <Title
        title={String(project.name)}
        subtitle={`${project.environment} · ${String(project.autonomyMode).replaceAll("_", " ")}`}
        badge={String(project.status)}
      />
      <div className="tabs">
        {[
          "Overview",
          "Tasks",
          "Architecture / Context",
          "Infrastructure",
          "API",
          "Database",
          "Runs",
          "Artifacts",
          "Audit",
        ].map((value) => (
          <a
            href={`#${value.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`}
            key={value}
          >
            {value}
          </a>
        ))}
      </div>
      <section id="overview">
        <div className="statusGrid">
          <Info label="Environment" value={project.environment} />
          <Info label="Autonomy" value={project.autonomyMode} />
          <Info label="Tasks" value={tasks.length} />
          <Info label="Artifacts" value={artifacts.length} />
        </div>
      </section>
      <Panel title="Tasks">
        <Tasks
          projects={[
            {
              id: projectId,
              name: String(project.name),
              tasks,
              runs: data.runs as Run[],
              environment: String(project.environment),
              autonomyMode: String(project.autonomyMode),
              status: String(project.status),
              taskSource: String(project.sourceType),
              createdAt: String(project.createdAt),
              warningCount: 0,
              recentEvents: [],
            },
          ]}
        />
      </Panel>
      <Panel title="Architecture / Context">
        <JsonView value={data.context} />
      </Panel>
      <Panel title="Infrastructure">
        <Table
          headers={["Type", "Provider", "Reference", "Environment", "Status"]}
          rows={resources.map((value) => [
            String(value.type),
            String(value.provider),
            String(value.externalReference),
            String(value.environment),
            <Badge key="s" value={String(value.status)} />,
          ])}
        />
      </Panel>
      <Panel title="API Explorer">
        <ApiExplorer
          api={data.api as Json}
          resources={resources}
          projectId={projectId}
          tasks={tasks}
        />
      </Panel>
      <Panel title="Database">
        <DatabasePanel value={data.database as Json} />
      </Panel>
      <Panel title="Artifact Browser">
        <ArtifactBrowser artifacts={artifacts} />
      </Panel>
      <Panel title="Audit">
        <Timeline events={audit.slice(-30)} />
      </Panel>
    </div>
  );
}
export function TaskDetail({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { data, error, reload } = usePolling<Json>(
    `/projects/${projectId}/tasks/${taskId}`,
  );
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return <Loading />;
  const task = data.task as Json,
    artifacts = data.artifacts as Artifact[],
    timeline = data.timeline as Array<{
      timestamp: string;
      title: string;
      status: string;
      summary: string;
      details: unknown;
    }>;
  return (
    <div className="page">
      <div className="breadcrumbs">
        <Link href={`/projects?projectId=${encodeURIComponent(projectId)}`}>Project</Link>
        <span>/</span>
        {String(task.externalKey)}
      </div>
      <Title
        title={String(task.title)}
        subtitle={`${task.externalKey} · ${short(String(data.commitSha ?? ""))}`}
        badge={String(task.state)}
      />
      <Lifecycle
        items={
          data.lifecycle as Array<{
            state: string;
            complete: boolean;
            current: boolean;
          }>
        }
      />
      <div className="grid two">
        <Panel title="Human timeline">
          <div className="timeline">
            {timeline.map((event, index) => (
              <details key={`${event.timestamp}-${index}`}>
                <summary>
                  <span className={`eventDot ${tone(event.status)}`} />
                  <time>{formatTime(event.timestamp)}</time>
                  <div>
                    <strong>{event.title}</strong>
                    <small>{event.summary}</small>
                  </div>
                </summary>
                <JsonView value={event.details} />
              </details>
            ))}
          </div>
        </Panel>
        <Panel title="Task facts">
          <div className="statusGrid">
            <Info label="State" value={task.state} />
            <Info label="Branch" value={data.branch} />
            <Info label="Commit" value={data.commitSha} />
            <Info label="Repair attempts" value={task.repairAttempts} />
            <Info label="Artifacts" value={artifacts.length} />
          </div>
        </Panel>
      </div>
      <Detail title="Requirements" value={data.requirements} />
      <Detail title="Implementation Plan" value={data.plan} />
      <Detail title="Architecture Guard" value={data.architecture} />
      <Detail title="Code Changes" value={data.codeChanges} />
      <Detail title="Database Changes" value={data.databaseChanges} />
      <Detail title="API Changes" value={data.apiChanges} />
      <Detail title="Tests" value={data.tests} />
      <Detail title="GitHub CI" value={data.ci} />
      <Detail title="Independent Review" value={data.review} />
      <Detail title="Repair History" value={data.repairHistory} />
      <Detail title="Final Manifest" value={data.finalManifest} />
      <Panel title="All artifacts">
        <ArtifactBrowser artifacts={artifacts} />
      </Panel>
    </div>
  );
}
function ApiExplorer({
  api,
  resources,
  projectId,
  tasks,
}: {
  api: Json;
  resources: Json[];
  projectId: string;
  tasks: Task[];
}) {
  const contracts = (api.contracts ?? []) as Artifact[];
  const document = extractOpenApi(contracts.at(-1)?.content);
  const endpoints = Object.entries((document?.paths ?? {}) as Json).flatMap(
    ([path, methods]) =>
      Object.entries(methods as Json).map(([method, definition]) => ({
        path,
        method: method.toUpperCase(),
        definition: definition as Json,
      })),
  );
  const httpResources = resources.filter((value) => value.type === "HTTP_API");
  const [selected, setSelected] = useState(0);
  const endpoint = endpoints[selected];
  const [body, setBody] = useState("{}");
  const [path, setPath] = useState(endpoint?.path ?? "");
  const [query, setQuery] = useState("{}");
  const [identity, setIdentity] = useState(
    "00000000-0000-0000-0000-000000000001",
  );
  const [resourceId, setResourceId] = useState(
    String(httpResources[0]?.resourceId ?? ""),
  );
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [result, setResult] = useState<unknown>();
  useEffect(() => setPath(endpoint?.path ?? ""), [endpoint?.path]);
  async function send() {
    if (!endpoint || !resourceId) return;
    try {
      const response = await authorizedFetch(`${apiBase(projectId)}/api-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: taskId || undefined,
          resourceId,
          method: endpoint.method,
          path,
          headers: { "x-user-id": identity },
          query: JSON.parse(query) as unknown,
          body: ["GET", "DELETE", "HEAD"].includes(endpoint.method)
            ? undefined
            : (JSON.parse(body) as unknown),
          operationId: crypto.randomUUID(),
        }),
      });
      setResult(await response.json());
    } catch {
      setResult({
        error: {
          message: "Request body and query must contain valid JSON.",
        },
      });
    }
  }
  async function saveScenario() {
    if (!endpoint || !resourceId) return;
    try {
      const response = await authorizedFetch(`${apiBase(projectId)}/scenarios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: taskId || undefined,
          resourceId,
          name: `${endpoint.method} ${path}`,
          description: "Saved from Operator Console API Explorer",
          operationId: crypto.randomUUID(),
          steps: [
            {
              name: `${endpoint.method} ${path}`,
              method: endpoint.method,
              path,
              headers: { "x-user-id": identity },
              query: JSON.parse(query) as unknown,
              body: ["GET", "DELETE", "HEAD"].includes(endpoint.method)
                ? undefined
                : (JSON.parse(body) as unknown),
            },
          ],
        }),
      });
      setResult(await response.json());
    } catch {
      setResult({
        error: { message: "Scenario fields must contain valid JSON." },
      });
    }
  }
  return (
    <div className="apiExplorer">
      <div className="endpointList">
        {endpoints.map((value, index) => (
          <button
            key={`${value.method}-${value.path}`}
            onClick={() => setSelected(index)}
            className={selected === index ? "selected" : ""}
          >
            <Method value={value.method} />
            <span>{value.path}</span>
          </button>
        ))}
      </div>
      <div className="endpointDetail">
        {endpoint ? (
          <>
            <div className="row">
              <Method value={endpoint.method} />
              <h3>{endpoint.path}</h3>
            </div>
            <p>
              {String(
                endpoint.definition.description ??
                  endpoint.definition.summary ??
                  "Endpoint from the project OpenAPI contract",
              )}
            </p>
            <JsonView value={endpoint.definition} />
            <div className="form">
              <label>
                Sandbox target
                <select
                  value={resourceId}
                  onChange={(event) => setResourceId(event.target.value)}
                >
                  {httpResources.map((resource) => (
                    <option
                      value={String(resource.resourceId)}
                      key={String(resource.resourceId)}
                    >
                      {String(resource.externalReference)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task evidence
                <select
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                >
                  {tasks.map((task) => (
                    <option value={task.id} key={task.id}>
                      {task.externalKey}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Request path / path parameters
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                />
              </label>
              <label>
                Query parameters (JSON)
                <textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label>
                Test identity
                <input
                  value={identity}
                  onChange={(event) => setIdentity(event.target.value)}
                />
              </label>
              <label>
                Request body
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
              </label>
              <button
                disabled={!httpResources.length}
                onClick={() => void send()}
              >
                Send sandbox request
              </button>
              <button
                disabled={!httpResources.length}
                onClick={() => void saveScenario()}
              >
                Save current request as scenario
              </button>
              {!httpResources.length && (
                <small className="warning">
                  Register a non-production HTTP_API resource to enable
                  requests. Browser-provided auth secrets are forbidden.
                </small>
              )}
            </div>
            {result !== undefined && <JsonView value={result} />}
          </>
        ) : (
          <Empty text="OpenAPI contract is not available." />
        )}
      </div>
    </div>
  );
}
function DatabasePanel({ value }: { value: Json }) {
  const migrations = (value.migrations ?? []) as Artifact[];
  const schema = (value.schema ?? {}) as Json;
  const schemaDiff = (value.schemaDiff ?? []) as unknown[];
  return (
    <div>
      <div className="statusGrid">
        <Info label="Provider" value={value.provider} />
        <Info label="Connection" value={value.status} />
        <Info label="Migrations" value={migrations.length} />
        <Info
          label="Public tables"
          value={Array.isArray(schema.tables) ? schema.tables.length : 0}
        />
        <Info
          label="RLS policies"
          value={Array.isArray(schema.policies) ? schema.policies.length : 0}
        />
        <Info
          label="Functions"
          value={Array.isArray(schema.functions) ? schema.functions.length : 0}
        />
      </div>
      {schemaDiff.length > 0 && (
        <details className="artifact" open>
          <summary>
            <Badge value="SCHEMA DIFF" />
            <strong>{schemaDiff.length} recorded changes</strong>
          </summary>
          <JsonView value={schemaDiff} />
        </details>
      )}
      {Object.keys(schema).length > 0 && (
        <details className="artifact">
          <summary>
            <Badge value="SCHEMA" />
            <strong>Tables, columns, indexes, policies and functions</strong>
          </summary>
          <JsonView value={schema} />
        </details>
      )}
      {migrations.map((migration) => (
        <details className="artifact" key={migration.id}>
          <summary>
            <Badge value="MIGRATION" />
            <strong>{formatDate(migration.createdAt)}</strong>
          </summary>
          <JsonView value={migration.content} />
        </details>
      ))}
    </div>
  );
}
function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  const [filter, setFilter] = useState("ALL");
  const [taskFilter, setTaskFilter] = useState("ALL");
  const [runFilter, setRunFilter] = useState("ALL");
  const [createdAfter, setCreatedAfter] = useState("");
  const kinds = ["ALL", ...new Set(artifacts.map((value) => value.kind))];
  const taskIds = [
    "ALL",
    ...new Set(
      artifacts.flatMap((value) => (value.taskId ? [value.taskId] : [])),
    ),
  ];
  const runIds = [
    "ALL",
    ...new Set(
      artifacts.flatMap((value) => (value.runId ? [value.runId] : [])),
    ),
  ];
  const visible = artifacts.filter(
    (value) =>
      (filter === "ALL" || value.kind === filter) &&
      (taskFilter === "ALL" || value.taskId === taskFilter) &&
      (runFilter === "ALL" || value.runId === runFilter) &&
      (!createdAfter ||
        value.createdAt >= new Date(createdAfter).toISOString()),
  );
  return (
    <div>
      <div className="filterBar">
        <label>
          Type
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {kinds.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Task
          <select
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value)}
          >
            {taskIds.map((value) => (
              <option key={value}>
                {value === "ALL" ? value : value.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run
          <select
            value={runFilter}
            onChange={(event) => setRunFilter(event.target.value)}
          >
            {runIds.map((value) => (
              <option key={value}>
                {value === "ALL" ? value : value.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Created after
          <input
            type="date"
            value={createdAfter}
            onChange={(event) => setCreatedAfter(event.target.value)}
          />
        </label>
      </div>
      <div className="artifactList">
        {[...visible].reverse().map((value) => (
          <details className="artifact" key={value.id}>
            <summary>
              <Badge value={value.kind} />
              <span>{formatDate(value.createdAt)}</span>
              <code>{value.id.slice(0, 8)}</code>
            </summary>
            <JsonView value={value.content} />
          </details>
        ))}
      </div>
    </div>
  );
}
function ValidationResult({ artifact }: { artifact: Artifact }) {
  const content = artifact.content as Json;
  return (
    <div>
      <div className="row between">
        <Badge value={String(content.result)} />
        <span>
          {String((content.counts as Json)?.passed ?? 0)} passed ·{" "}
          {String((content.counts as Json)?.failed ?? 0)} failed ·{" "}
          {String((content.counts as Json)?.skipped ?? 0)} skipped
        </span>
      </div>
      <p>{String(content.humanSummary)}</p>
      <JsonView value={content.checks} />
    </div>
  );
}
function Timeline({ events }: { events: Audit[] }) {
  return (
    <div className="timeline">
      {[...events].reverse().map((event) => (
        <details key={event.id}>
          <summary>
            <span className="eventDot ok" />
            <time>{formatTime(event.timestamp)}</time>
            <div>
              <strong>{humanAction(event.action)}</strong>
              <small>{event.reason}</small>
            </div>
          </summary>
          <JsonView
            value={{
              actor: event.actor,
              result: event.result,
              resource: event.resourceId,
            }}
          />
        </details>
      ))}
    </div>
  );
}
function Lifecycle({
  items,
}: {
  items: Array<{ state: string; complete: boolean; current: boolean }>;
}) {
  return (
    <div className="lifecycle">
      {items.map((item, index) => (
        <div
          key={item.state}
          className={`${item.complete ? "complete" : ""} ${item.current ? "current" : ""}`}
        >
          <span>{index + 1}</span>
          <strong>{item.state}</strong>
        </div>
      ))}
    </div>
  );
}
function Detail({ title, value }: { title: string; value: unknown }) {
  return (
    <Panel title={title}>
      {value === undefined || value === null ? (
        <Empty text="No evidence recorded." />
      ) : (
        <JsonView value={value} />
      )}
    </Panel>
  );
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Title({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <div className="title">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {badge && <Badge value={badge} />}
    </div>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span className={`badge ${tone(value)}`}>{value.replaceAll("_", " ")}</span>
  );
}
function Method({ value }: { value: string }) {
  return <span className={`method ${value.toLowerCase()}`}>{value}</span>;
}
function Info({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>
        {value === undefined || value === null || value === ""
          ? "—"
          : String(value)}
      </strong>
    </div>
  );
}
function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {headers.map((value) => (
              <th key={value}>{value}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td key={cell}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Loading({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? "loading small" : "loading"}>
      Loading live state…
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry: () => Promise<void>;
}) {
  return (
    <div className="errorState">
      <h2>Console data unavailable</h2>
      <p>{message}</p>
      <button onClick={() => void retry()}>Retry</button>
    </div>
  );
}
function label(section: string) {
  return (
    (
      {
        dashboard: "Dashboard",
        projects: "Projects",
        tasks: "Tasks",
        delivery: "Delivery",
        runs: "Runs",
        validation: "Validation Center",
        infrastructure: "Infrastructure",
        artifacts: "Artifacts",
        audit: "Audit",
        capabilities: "Capabilities",
        settings: "Settings",
      } as Record<string, string>
    )[section] ?? "Dashboard"
  );
}
function subtitle(section: string) {
  return (
    (
      {
        dashboard: "What is running, ready, or needs attention",
        projects: "Registered targets and their current state",
        tasks: "Every task from requirements to READY",
        delivery: "Which upstream epic shipped, proven by which gates, merged into which branch",
        runs: "Branches, commits, repair attempts and outcomes",
        validation: "Run and inspect backend verification without a terminal",
        infrastructure: "Only explicitly allowlisted sandbox resources",
        artifacts: "Evidence produced by plans, tests, CI and review",
        audit: "Who did what, when, and why",
        capabilities: "Evidence-based provider readiness",
        settings: "Safety boundaries and future integrations",
      } as Record<string, string>
    )[section] ?? ""
  );
}
function tone(value: string) {
  const normalized = value.toUpperCase();
  if (
    [
      "READY",
      "PASS",
      "PASSED",
      "SUCCEEDED",
      "SUCCESS",
      "ACTIVE",
      "LIVE_TESTED",
      "COMPLETE",
      "COMPLETED",
    ].includes(normalized)
  )
    return "ok";
  if (["FAILED", "FAIL", "BLOCKED", "NOT_SUPPORTED"].includes(normalized))
    return "bad";
  if (
    [
      "RUNNING",
      "IMPLEMENTING",
      "TESTING",
      "REVIEWING",
      "PARTIAL",
      "CONFIGURED",
      "SUPPORTED",
    ].includes(normalized)
  )
    return "warn";
  return "neutral";
}
function short(value?: string) {
  return value ? value.slice(0, 8) : "—";
}
function formatDate(value: unknown) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(String(value)));
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
function humanAction(value: string) {
  return value
    .split(".")
    .map((word) => word.replaceAll("_", " "))
    .join(" › ");
}
function apiBase(projectId: string) {
  return `${api}/projects/${projectId}`;
}
function latestCiStatus(value: unknown) {
  if (!value || typeof value !== "object") return "NOT CONFIGURED";
  const content = value as Json;
  const ci =
    content.ci && typeof content.ci === "object"
      ? (content.ci as Json)
      : content;
  return String(ci.conclusion ?? ci.status ?? "UNKNOWN").toUpperCase();
}
function extractOpenApi(content: unknown) {
  const value = content as { contracts?: Array<{ document?: Json }> };
  return value?.contracts?.[0]?.document;
}
