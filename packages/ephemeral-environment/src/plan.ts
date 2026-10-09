// How to build, start and reach a project's backend in a throwaway environment, decided from the
// repository itself.
//
// Verifying a backend over real HTTP used to need a running test server whose address somebody
// registered by hand. For "the Java port passes the whole collection" that meant asking a person
// for a URL -- exactly the manual step the autopilot exists to remove, and one that does not
// exist at all for a project nobody has deployed yet. An ephemeral environment removes it: build
// the commit, start its dependencies, start the application, verify it, throw it all away. This
// module is the first half of that: it reads a repository and produces an EnvironmentPlan -- the
// stack, the image, the build and run commands (argv, never a shell string), the port, the health
// probes and the dependency containers -- with the evidence behind every decision.
//
// Inference covers the common shapes (Gradle and Maven for Kotlin and Java, Node, Python, Go).
// A project can pin or override any of it in `.autopilot/environment.yml`. Whatever can be
// neither inferred nor read from the manifest is returned as `unresolved` with a concrete
// remediation; an unresolved plan is never executed, and the run that needed it is NOT_PROVEN
// with that reason -- never a silent guess presented as a result.
//
// Pure and Web-only (plus the `yaml` parser), so the same plan can be previewed from the Edge MCP
// and executed by the GitHub Actions harness.
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ENVIRONMENT_PLAN_VERSION = "1";
export const MANIFEST_PATHS = [".autopilot/environment.yml", ".autopilot/environment.yaml", ".autopilot/environment.json"];

/** The repository as the planner sees it: paths relative to the repository root, read on demand. */
export interface ProjectFiles {
  paths: string[];
  read(path: string): Promise<string | undefined>;
}

const argv = z.array(z.string().min(1).max(500)).min(1).max(64);
const imageReference = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/-]{0,199}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/, "an image reference such as eclipse-temurin:21-jdk");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const healthPath = z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}$/);
export const dependencyKindSchema = z.enum(["POSTGRES", "MYSQL", "REDIS", "MONGO"]);
export type DependencyKind = z.infer<typeof dependencyKindSchema>;

const secretLikeName = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)/i;
const templateOnly = /^(?:[^{}]|\{\{[a-z]+\.(host|port|user|password|database|url)\}\})*$/;

/** `.autopilot/environment.yml`: every field optional, every field overrides inference. */
export const environmentManifestSchema = z
  .object({
    version: z.literal(1),
    root: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/).optional(),
    image: imageReference.optional(),
    install: z.array(argv).max(8).optional(),
    build: z.array(argv).max(8).optional(),
    prepare: z.array(argv).max(8).optional(),
    run: argv.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    health: z.array(healthPath).min(1).max(8).optional(),
    startupTimeoutSeconds: z.number().int().min(10).max(1800).optional(),
    env: z.record(envName, z.string().max(2000)).optional(),
    dependencies: z
      .array(
        z.object({
          kind: dependencyKindSchema,
          image: imageReference.optional(),
          env: z.record(envName, z.string().max(2000)).optional(),
        }),
      )
      .max(6)
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    // A literal credential in a committed file is a leaked credential. Dependency credentials are
    // throwaway values the harness generates, referenced as {{postgres.password}} and friends.
    const check = (env: Record<string, string> | undefined, path: (string | number)[]) => {
      for (const [key, value] of Object.entries(env ?? {}))
        if (secretLikeName.test(key) && !(/\{\{[a-z]+\.(password|url)\}\}/.test(value) && templateOnly.test(value)))
          context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: `${key} must reference a generated dependency credential such as {{postgres.password}}, never a literal value` });
    };
    check(manifest.env, ["env"]);
    manifest.dependencies?.forEach((dependency, index) => check(dependency.env, ["dependencies", index, "env"]));
  });
export type EnvironmentManifest = z.infer<typeof environmentManifestSchema>;

export const environmentPlanSchema = z.object({
  planVersion: z.literal(ENVIRONMENT_PLAN_VERSION),
  root: z.string(),
  stack: z.object({
    language: z.enum(["KOTLIN", "JAVA", "TYPESCRIPT", "JAVASCRIPT", "PYTHON", "GO", "UNKNOWN"]),
    buildTool: z.enum(["GRADLE", "MAVEN", "NPM", "PNPM", "YARN", "PIP", "GO", "NONE"]),
    framework: z.string().optional(),
    runtimeVersion: z.string().optional(),
  }),
  image: z.string(),
  install: z.array(argv),
  build: z.array(argv),
  prepare: z.array(argv),
  run: argv.optional(),
  port: z.number().int(),
  health: z.array(z.string()),
  startupTimeoutSeconds: z.number().int(),
  env: z.record(z.string()),
  dependencies: z.array(z.object({ kind: dependencyKindSchema, image: z.string(), env: z.record(z.string()), reason: z.string() })),
  source: z.enum(["INFERRED", "MANIFEST", "MIXED"]),
  evidence: z.array(z.string()),
  notes: z.array(z.string()),
  unresolved: z.array(z.object({ field: z.string(), reason: z.string(), remediation: z.string() })),
});
export type EnvironmentPlan = z.infer<typeof environmentPlanSchema>;
type Dependency = EnvironmentPlan["dependencies"][number];

const ignored = /(^|\/)(node_modules|\.git|\.gradle|build|dist|out|target|vendor|\.venv|venv|__pycache__|\.next|examples?|samples?|test-?fixtures?|testdata)(\/|$)/i;
const buildMarkers: Array<{ family: string; pattern: RegExp }> = [
  { family: "jvm", pattern: /(^|\/)(settings\.gradle(\.kts)?|build\.gradle(\.kts)?|pom\.xml)$/ },
  { family: "node", pattern: /(^|\/)package\.json$/ },
  { family: "python", pattern: /(^|\/)(pyproject\.toml|requirements\.txt|manage\.py)$/ },
  { family: "go", pattern: /(^|\/)go\.mod$/ },
];

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
function within(root: string, path: string) {
  return root === "" ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}
function join(root: string, path: string) {
  return root ? `${root}/${path}` : path;
}

/**
 * Where the application lives. The repository root when it carries a build file; otherwise the
 * single shallowest directory that does. Several candidates are a question for the project, not
 * a guess: picking one silently could verify the wrong service and call it proven.
 */
export function detectRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    if (ignored.test(path) || path.split("/").length > 3) continue;
    if (buildMarkers.some((marker) => marker.pattern.test(path))) roots.add(dirname(path));
  }
  if (roots.has("")) return [""];
  const sorted = [...roots].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  // A module of a build already selected (a Gradle subproject, a nested package) is not another app.
  return sorted.filter((root) => !sorted.some((other) => other !== root && root.startsWith(`${other}/`)));
}

async function readAll(files: ProjectFiles, paths: string[], limit = 40): Promise<string> {
  const texts = await Promise.all(paths.slice(0, limit).map((path) => files.read(path).catch(() => undefined)));
  return texts.filter((text): text is string => typeof text === "string").join("\n");
}

interface Context {
  files: ProjectFiles;
  root: string;
  local: string[];
  has: (path: string) => boolean;
  read: (path: string) => Promise<string | undefined>;
  evidence: string[];
  notes: string[];
  unresolved: EnvironmentPlan["unresolved"];
}

type Recipe = Omit<EnvironmentPlan, "planVersion" | "root" | "dependencies" | "source" | "evidence" | "notes" | "unresolved" | "env"> & {
  env: Record<string, string>;
};

// `legacyJava` turns Java's old "1.8" spelling into "8"; applied to any other runtime it would
// turn Go 1.23 into "23".
function majorVersion(text: string, patterns: RegExp[], fallback: string, legacyJava = false): { value: string; found: boolean } {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return { value: legacyJava ? match[1].replace(/^1\.(\d+)$/, "$1") : match[1], found: true };
  }
  return { value: fallback, found: false };
}

async function jvmRecipe(context: Context): Promise<Recipe> {
  const gradle = context.local.some((path) => /(^|\/)(build|settings)\.gradle(\.kts)?$/.test(path));
  const buildFiles = context.local.filter((path) => (gradle ? /(^|\/)build\.gradle(\.kts)?$/ : /(^|\/)pom\.xml$/).test(path) && path.split("/").length <= 3);
  const perFile = await Promise.all(buildFiles.slice(0, 40).map(async (path) => ({ path, text: (await context.read(path).catch(() => undefined)) ?? "" })));
  const text = perFile.map((value) => value.text).join("\n");
  const kotlin = /org\.jetbrains\.kotlin|kotlin\("jvm"\)|kotlin-maven-plugin/.test(text) || context.local.some((path) => /(^|\/)src\/main\/kotlin\//.test(path));
  const framework = /org\.springframework\.boot/.test(text)
    ? "SPRING_BOOT"
    : /io\.ktor/.test(text)
      ? "KTOR"
      : /io\.quarkus/.test(text)
        ? "QUARKUS"
        : /io\.micronaut/.test(text)
          ? "MICRONAUT"
          : undefined;
  const java = majorVersion(
    text,
    [
      /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
      /jvmToolchain\(\s*(\d+)\s*\)/,
      /JavaVersion\.VERSION_(?:1_)?(\d+)/,
      /sourceCompatibility\s*=\s*['"]?(1\.\d+|\d+)['"]?/,
      /<java\.version>\s*(1\.\d+|\d+)\s*</,
      /<maven\.compiler\.release>\s*(\d+)\s*</,
      /<maven\.compiler\.source>\s*(1\.\d+|\d+)\s*</,
    ],
    "21",
    true,
  );
  context.evidence.push(
    `${gradle ? "Gradle" : "Maven"} build (${buildFiles.slice(0, 3).join(", ") || "root"})`,
    `${kotlin ? "Kotlin" : "Java"}${framework ? ` with ${framework}` : ""}`,
    java.found ? `Java ${java.value} from the build's toolchain/compiler settings` : "no Java version declared; Java 21 assumed",
  );
  const port = 8080;
  const health = framework === "SPRING_BOOT" ? ["/actuator/health", "/health", "/"] : framework === "QUARKUS" ? ["/q/health", "/health", "/"] : ["/health", "/healthz", "/"];
  let run: string[] | undefined;
  let build: string[][];
  let image: string;
  if (gradle) {
    const wrapper = context.has("gradlew");
    const gradleCommand = wrapper ? "./gradlew" : "gradle";
    image = wrapper ? `eclipse-temurin:${java.value}-jdk` : `gradle:8-jdk${java.value}`;
    if (!wrapper) context.notes.push("no Gradle wrapper committed; the official gradle image's Gradle is used, which may differ from the version the project expects");
    build = [[gradleCommand, "--no-daemon", "assemble", "-x", "test"]];
    const springModules = perFile.filter((value) => /id\s*\(?\s*["']org\.springframework\.boot["']|apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']/.test(value.text));
    if (framework === "SPRING_BOOT") run = [gradleCommand, "--no-daemon", "bootRun"];
    else if (framework === "QUARKUS") run = [gradleCommand, "--no-daemon", "quarkusRun"];
    else if (/\bapplication\b|mainClass/.test(text)) run = [gradleCommand, "--no-daemon", "run"];
    if (framework === "SPRING_BOOT" && springModules.length > 1)
      context.notes.push(`${springModules.length} Gradle build files mention Spring Boot; bootRun starts every module that applies the plugin -- pin "run" in the manifest if that is not one application`);
  } else {
    const wrapper = context.has("mvnw");
    const maven = wrapper ? "./mvnw" : "mvn";
    image = wrapper ? `eclipse-temurin:${java.value}-jdk` : `maven:3-eclipse-temurin-${java.value}`;
    build = [[maven, "-B", "-DskipTests", "package"]];
    if (framework === "SPRING_BOOT") run = [maven, "-B", "spring-boot:run"];
    else if (framework === "QUARKUS") run = [maven, "-B", "quarkus:run"];
    else if (framework === "MICRONAUT") run = [maven, "-B", "mn:run"];
  }
  if (!run)
    context.unresolved.push({
      field: "run",
      reason: `no way to start a ${gradle ? "Gradle" : "Maven"} application without a known framework or the application plugin`,
      remediation: 'declare "run" (argv) in .autopilot/environment.yml, for example ["./gradlew", "--no-daemon", "run"]',
    });
  return {
    stack: { language: kotlin ? "KOTLIN" : "JAVA", buildTool: gradle ? "GRADLE" : "MAVEN", ...(framework ? { framework } : {}), runtimeVersion: java.value },
    image,
    install: [],
    build,
    prepare: [],
    ...(run ? { run } : {}),
    port,
    health,
    startupTimeoutSeconds: 300,
    env: { SERVER_PORT: String(port), PORT: String(port), QUARKUS_HTTP_PORT: String(port), MICRONAUT_SERVER_PORT: String(port) },
  };
}

async function nodeRecipe(context: Context): Promise<Recipe> {
  const manifest = JSON.parse((await context.read("package.json")) ?? "{}") as {
    scripts?: Record<string, string>;
    main?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const manager = context.has("pnpm-lock.yaml") ? "pnpm" : context.has("yarn.lock") ? "yarn" : "npm";
  const nvmrc = (await context.read(".nvmrc"))?.trim();
  const node = majorVersion(`${manifest.engines?.node ?? ""} ${nvmrc ?? ""}`, [/(\d{2})/], "22");
  const framework = deps["@nestjs/core"] ? "NESTJS" : deps["fastify"] ? "FASTIFY" : deps["express"] ? "EXPRESS" : deps["koa"] ? "KOA" : deps["hono"] ? "HONO" : undefined;
  context.evidence.push(`Node.js package with ${manager}${framework ? ` and ${framework}` : ""}`, node.found ? `Node ${node.value} from engines/.nvmrc` : "no Node version declared; Node 22 assumed");
  // Every step runs in a fresh container that shares only the mounted workspace, so pnpm and yarn
  // are invoked through corepack each time: a `corepack enable` in one step is gone in the next.
  const pm = manager === "npm" ? ["npm"] : ["corepack", manager];
  const install =
    manager === "npm"
      ? [["npm", context.has("package-lock.json") ? "ci" : "install"]]
      : [[...pm, "install", "--frozen-lockfile"]];
  const build = manifest.scripts?.["build"] ? [[...pm, "run", "build"]] : [];
  const prepare = deps["prisma"] || deps["@prisma/client"] ? [["npx", "prisma", "migrate", "deploy"]] : [];
  if (prepare.length) context.evidence.push("Prisma migrations are applied before start");
  const run = manifest.scripts?.["start"] ? [...pm, "run", "start"] : manifest.main ? ["node", manifest.main] : undefined;
  if (!run)
    context.unresolved.push({ field: "run", reason: 'package.json has neither a "start" script nor "main"', remediation: 'add a "start" script or declare "run" in .autopilot/environment.yml' });
  const port = 3000;
  return {
    stack: { language: deps["typescript"] || context.has("tsconfig.json") ? "TYPESCRIPT" : "JAVASCRIPT", buildTool: manager === "pnpm" ? "PNPM" : manager === "yarn" ? "YARN" : "NPM", ...(framework ? { framework } : {}), runtimeVersion: node.value },
    image: `node:${node.value}`,
    install,
    build,
    prepare,
    ...(run ? { run } : {}),
    port,
    health: ["/health", "/healthz", "/"],
    startupTimeoutSeconds: 180,
    env: { PORT: String(port), NODE_ENV: "test" },
  };
}

async function pythonModuleWith(context: Context, marker: RegExp): Promise<{ module: string; variable: string } | undefined> {
  const candidates = ["main.py", "app.py", "app/main.py", "src/main.py", "src/app/main.py", "api/main.py", "server.py", "wsgi.py", "asgi.py"].filter(context.has);
  for (const path of candidates) {
    const text = (await context.read(path)) ?? "";
    const match = new RegExp(`^(\\w+)\\s*=\\s*${marker.source}`, "m").exec(text);
    if (match?.[1]) return { module: path.replace(/^src\//, "").replace(/\.py$/, "").replace(/\//g, "."), variable: match[1] };
  }
  return undefined;
}

async function pythonRecipe(context: Context): Promise<Recipe> {
  const pyproject = (await context.read("pyproject.toml")) ?? "";
  const requirements = (await context.read("requirements.txt")) ?? "";
  const text = `${pyproject}\n${requirements}`.toLowerCase();
  const python = majorVersion(`${pyproject} ${(await context.read(".python-version")) ?? ""}`, [/requires-python\s*=\s*["'][^0-9]*(3\.\d+)/, /^(3\.\d+)/m], "3.12");
  const port = 8000;
  const install = context.has("requirements.txt") ? [["pip", "install", "--no-cache-dir", "-r", "requirements.txt"]] : [["pip", "install", "--no-cache-dir", "."]];
  let framework: string | undefined;
  let run: string[] | undefined;
  const prepare: string[][] = [];
  if (context.has("manage.py") || /\bdjango\b/.test(text)) {
    framework = "DJANGO";
    run = ["python", "manage.py", "runserver", "--noreload", `0.0.0.0:${port}`];
    prepare.push(["python", "manage.py", "migrate", "--noinput"]);
  } else if (/\bfastapi\b/.test(text)) {
    framework = "FASTAPI";
    const app = await pythonModuleWith(context, /FastAPI\(/);
    if (app) run = ["python", "-m", "uvicorn", `${app.module}:${app.variable}`, "--host", "0.0.0.0", "--port", String(port)];
  } else if (/\bflask\b/.test(text)) {
    framework = "FLASK";
    const app = await pythonModuleWith(context, /Flask\(/);
    if (app) run = ["python", "-m", "flask", "--app", `${app.module}:${app.variable}`, "run", "--host", "0.0.0.0", "--port", String(port)];
  }
  if (context.has("alembic.ini")) prepare.push(["alembic", "upgrade", "head"]);
  context.evidence.push(`Python ${context.has("requirements.txt") ? "requirements.txt" : "pyproject"} project${framework ? ` with ${framework}` : ""}`);
  if (!run)
    context.unresolved.push({
      field: "run",
      reason: framework ? `the ${framework} application object was not found in the usual entry modules` : "no known Python web framework was detected",
      remediation: 'declare "run" in .autopilot/environment.yml, for example ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]',
    });
  return {
    stack: { language: "PYTHON", buildTool: "PIP", ...(framework ? { framework } : {}), runtimeVersion: python.value },
    image: `python:${python.value}-slim`,
    install,
    build: [],
    prepare,
    ...(run ? { run } : {}),
    port,
    health: ["/health", "/healthz", "/docs", "/"],
    startupTimeoutSeconds: 180,
    env: { PORT: String(port), PYTHONUNBUFFERED: "1" },
  };
}

async function goRecipe(context: Context): Promise<Recipe> {
  const mod = (await context.read("go.mod")) ?? "";
  const go = majorVersion(mod, [/^go\s+(\d+\.\d+)/m], "1.22");
  const mains = context.local.filter((path) => /^(main\.go|cmd\/[^/]+\/main\.go)$/.test(path));
  let target: string | undefined;
  if (mains.includes("main.go")) target = ".";
  else if (mains.length === 1) target = `./${dirname(mains[0] ?? "")}`;
  context.evidence.push(`Go module (go ${go.value})`);
  if (!target)
    context.unresolved.push({
      field: "run",
      reason: mains.length ? `several main packages: ${mains.join(", ")}` : "no main package found at the root or under cmd/",
      remediation: 'declare "build" and "run" in .autopilot/environment.yml',
    });
  const port = 8080;
  return {
    stack: { language: "GO", buildTool: "GO", runtimeVersion: go.value },
    image: `golang:${go.value}`,
    install: [["go", "mod", "download"]],
    // Built into the workspace, not /tmp: the run step is a new container that only shares it.
    build: target ? [["go", "build", "-o", ".autopilot/bin/app", target]] : [],
    prepare: [],
    ...(target ? { run: ["./.autopilot/bin/app"] } : {}),
    port,
    health: ["/health", "/healthz", "/"],
    startupTimeoutSeconds: 120,
    env: { PORT: String(port) },
  };
}

// Throwaway dependency containers. Credentials are templates the harness fills with values it
// generates per run, so no plan, artifact or log ever carries a usable credential.
const dependencyRules: Array<{ kind: DependencyKind; pattern: RegExp; image: string; imagePattern: RegExp }> = [
  { kind: "POSTGRES", pattern: /org\.postgresql|\bpostgresql\b|jdbc:postgresql|"pg"\s*:|"postgres"\s*:|psycopg|asyncpg|jackc\/pgx|lib\/pq|provider\s*=\s*"postgresql"|exposed-jdbc.*postgres/i, image: "postgres:16-alpine", imagePattern: /^(docker\.io\/)?(library\/)?postgres(:|$)/ },
  { kind: "MYSQL", pattern: /mysql-connector|com\.mysql|jdbc:mysql|"mysql2?"\s*:|pymysql|mysqlclient|go-sql-driver\/mysql|mariadb/i, image: "mysql:8", imagePattern: /^(docker\.io\/)?(library\/)?(mysql|mariadb)(:|$)/ },
  { kind: "REDIS", pattern: /spring-boot-starter-data-redis|lettuce|jedis|"ioredis"\s*:|"redis"\s*:|^redis[>=<~ ]|^redis$|go-redis|redisson/im, image: "redis:7-alpine", imagePattern: /^(docker\.io\/)?(library\/)?redis(:|$)/ },
  { kind: "MONGO", pattern: /mongodb-driver|spring-boot-starter-data-mongodb|"mongoose"\s*:|"mongodb"\s*:|pymongo|motor\b|mongo-driver/i, image: "mongo:7", imagePattern: /^(docker\.io\/)?(library\/)?mongo(:|$)/ },
];
const unsupportedRules: Array<{ name: string; pattern: RegExp }> = [
  { name: "Kafka", pattern: /spring-kafka|kafka-clients|"kafkajs"\s*:|confluent-kafka|aiokafka/i },
  { name: "RabbitMQ", pattern: /spring-boot-starter-amqp|amqp-client|"amqplib"\s*:|\bpika\b/i },
  { name: "Elasticsearch", pattern: /elasticsearch/i },
];

function dependencyEnv(kind: DependencyKind, framework: string | undefined): Record<string, string> {
  const spring = framework === "SPRING_BOOT";
  switch (kind) {
    case "POSTGRES":
      return {
        DATABASE_URL: "postgres://{{postgres.user}}:{{postgres.password}}@{{postgres.host}}:{{postgres.port}}/{{postgres.database}}",
        JDBC_DATABASE_URL: "jdbc:postgresql://{{postgres.host}}:{{postgres.port}}/{{postgres.database}}",
        PGHOST: "{{postgres.host}}",
        PGPORT: "{{postgres.port}}",
        PGUSER: "{{postgres.user}}",
        PGPASSWORD: "{{postgres.password}}",
        PGDATABASE: "{{postgres.database}}",
        DB_HOST: "{{postgres.host}}",
        DB_PORT: "{{postgres.port}}",
        DB_USER: "{{postgres.user}}",
        DB_PASSWORD: "{{postgres.password}}",
        DB_NAME: "{{postgres.database}}",
        ...(spring
          ? {
              SPRING_DATASOURCE_URL: "jdbc:postgresql://{{postgres.host}}:{{postgres.port}}/{{postgres.database}}",
              SPRING_DATASOURCE_USERNAME: "{{postgres.user}}",
              SPRING_DATASOURCE_PASSWORD: "{{postgres.password}}",
            }
          : {}),
      };
    case "MYSQL":
      return {
        DATABASE_URL: "mysql://{{mysql.user}}:{{mysql.password}}@{{mysql.host}}:{{mysql.port}}/{{mysql.database}}",
        JDBC_DATABASE_URL: "jdbc:mysql://{{mysql.host}}:{{mysql.port}}/{{mysql.database}}",
        MYSQL_HOST: "{{mysql.host}}",
        MYSQL_PORT: "{{mysql.port}}",
        MYSQL_USER: "{{mysql.user}}",
        MYSQL_PASSWORD: "{{mysql.password}}",
        MYSQL_DATABASE: "{{mysql.database}}",
        ...(spring
          ? {
              SPRING_DATASOURCE_URL: "jdbc:mysql://{{mysql.host}}:{{mysql.port}}/{{mysql.database}}",
              SPRING_DATASOURCE_USERNAME: "{{mysql.user}}",
              SPRING_DATASOURCE_PASSWORD: "{{mysql.password}}",
            }
          : {}),
      };
    case "REDIS":
      return {
        REDIS_URL: "redis://{{redis.host}}:{{redis.port}}",
        REDIS_HOST: "{{redis.host}}",
        REDIS_PORT: "{{redis.port}}",
        ...(spring ? { SPRING_DATA_REDIS_HOST: "{{redis.host}}", SPRING_DATA_REDIS_PORT: "{{redis.port}}" } : {}),
      };
    case "MONGO":
      return {
        MONGODB_URI: "mongodb://{{mongo.host}}:{{mongo.port}}/{{mongo.database}}",
        MONGO_URL: "mongodb://{{mongo.host}}:{{mongo.port}}/{{mongo.database}}",
        ...(spring ? { SPRING_DATA_MONGODB_URI: "mongodb://{{mongo.host}}:{{mongo.port}}/{{mongo.database}}" } : {}),
      };
  }
}

async function detectDependencies(context: Context, framework: string | undefined): Promise<Dependency[]> {
  const sources = context.local.filter(
    (path) =>
      path.split("/").length <= 6 &&
      /(^|\/)(build\.gradle(\.kts)?|pom\.xml|package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|application[^/]*\.(ya?ml|properties|conf)|schema\.prisma|libs\.versions\.toml)$/.test(path),
  );
  const text = await readAll(context.files, sources.map((path) => join(context.root, path)), 60);
  // docker-compose files describe the dependencies the developers actually run; their image tags
  // are the best available statement of which major version the application expects.
  const composeImages: string[] = [];
  for (const path of context.files.paths.filter((value) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(value) && !ignored.test(value)).slice(0, 5)) {
    try {
      const document = parseYaml((await context.files.read(path)) ?? "") as { services?: Record<string, { image?: unknown }> };
      for (const service of Object.values(document?.services ?? {})) if (typeof service?.image === "string") composeImages.push(service.image);
    } catch {
      context.notes.push(`${path} could not be parsed; its dependency versions were not used`);
    }
  }
  const dependencies: Dependency[] = [];
  for (const rule of dependencyRules) {
    const composeImage = composeImages.find((image) => rule.imagePattern.test(image));
    if (!rule.pattern.test(text) && !composeImage) continue;
    const image = composeImage && imageReference.safeParse(composeImage).success ? composeImage : rule.image;
    dependencies.push({
      kind: rule.kind,
      image,
      env: dependencyEnv(rule.kind, framework),
      reason: rule.pattern.test(text) ? `${rule.kind.toLowerCase()} client or URL in the build/configuration` : `docker-compose service image ${composeImage}`,
    });
  }
  const sql = dependencies.filter((dependency) => dependency.kind === "POSTGRES" || dependency.kind === "MYSQL");
  if (sql.length > 1) context.notes.push(`both ${sql.map((value) => value.kind).join(" and ")} were detected; the first one owns the shared variables (DATABASE_URL, SPRING_DATASOURCE_URL)`);
  for (const rule of unsupportedRules)
    if (rule.pattern.test(text))
      context.notes.push(`${rule.name} is used but not provisioned yet; an application that cannot start without it reports ENVIRONMENT_BOOT_FAILED with its own log`);
  if (/flyway|liquibase/i.test(text)) context.evidence.push("database migrations (Flyway/Liquibase) run at application start");
  return dependencies;
}

function mergeEnv(dependencies: Dependency[], base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  // Later dependencies never overwrite a variable an earlier one owns (see the SQL note above).
  for (const dependency of dependencies) for (const [key, value] of Object.entries(dependency.env)) if (!(key in env)) env[key] = value;
  return { ...env, ...base };
}

/** Reads `.autopilot/environment.yml` if present. A broken manifest is reported, never ignored. */
export async function readManifest(files: ProjectFiles): Promise<{ manifest?: EnvironmentManifest; path?: string; errors: string[] }> {
  const path = MANIFEST_PATHS.find((value) => files.paths.includes(value));
  if (!path) return { errors: [] };
  try {
    const text = (await files.read(path)) ?? "";
    const parsed = environmentManifestSchema.safeParse(path.endsWith(".json") ? JSON.parse(text) : parseYaml(text));
    if (parsed.success) return { manifest: parsed.data, path, errors: [] };
    return { path, errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
  } catch (error) {
    return { path, errors: [`could not be parsed: ${error instanceof Error ? error.message.slice(0, 200) : "invalid"}`] };
  }
}

/**
 * The plan for one repository commit. `root` (from the caller) selects one application in a
 * repository that holds several; the manifest's own `root` wins over it.
 */
export async function planEnvironment(files: ProjectFiles, options: { root?: string } = {}): Promise<EnvironmentPlan> {
  const evidence: string[] = [];
  const notes: string[] = [];
  const unresolved: EnvironmentPlan["unresolved"] = [];
  const { manifest, path: manifestPath, errors } = await readManifest(files);
  if (manifestPath && errors.length)
    unresolved.push({ field: "manifest", reason: `${manifestPath} is invalid: ${errors.slice(0, 5).join("; ")}`, remediation: `fix ${manifestPath}; nothing in it is applied until it validates` });
  if (manifestPath && !errors.length) evidence.push(`${manifestPath} applied`);

  let root = manifest?.root ?? options.root;
  if (root === undefined) {
    const roots = detectRoots(files.paths);
    if (roots.length === 1) root = roots[0] ?? "";
    else {
      unresolved.push(
        roots.length
          ? { field: "root", reason: `several applications in the repository: ${roots.join(", ")}`, remediation: 'pass root for the one to verify, or set "root" in .autopilot/environment.yml' }
          : { field: "root", reason: "no build file (Gradle, Maven, package.json, pyproject/requirements, go.mod) was found", remediation: "declare the application in .autopilot/environment.yml" },
      );
      root = "";
    }
  } else evidence.push(`application root "${root || "."}" ${manifest?.root !== undefined ? "from the manifest" : "requested by the caller"}`);
  const local = files.paths.map((path) => within(root ?? "", path)).filter((path): path is string => path !== undefined && !ignored.test(path));
  const localSet = new Set(local);
  const context: Context = {
    files,
    root,
    local,
    has: (path) => localSet.has(path),
    read: (path) => files.read(join(root ?? "", path)),
    evidence,
    notes,
    unresolved,
  };

  let recipe: Recipe | undefined;
  if (local.some((path) => /^(build|settings)\.gradle(\.kts)?$|^pom\.xml$/.test(path))) recipe = await jvmRecipe(context);
  else if (context.has("package.json")) recipe = await nodeRecipe(context);
  else if (context.has("pyproject.toml") || context.has("requirements.txt") || context.has("manage.py")) recipe = await pythonRecipe(context);
  else if (context.has("go.mod")) recipe = await goRecipe(context);
  if (!recipe && !manifest?.run)
    unresolved.push({ field: "stack", reason: `no supported build was found at "${root || "."}"`, remediation: 'declare "image", "build" and "run" in .autopilot/environment.yml' });

  const inferredDependencies = await detectDependencies(context, recipe?.stack.framework);
  const dependencies = manifest?.dependencies
    ? manifest.dependencies.map((declared) => {
        const inferred = inferredDependencies.find((value) => value.kind === declared.kind);
        return {
          kind: declared.kind,
          image: declared.image ?? inferred?.image ?? dependencyRules.find((rule) => rule.kind === declared.kind)?.image ?? "",
          env: { ...(inferred?.env ?? dependencyEnv(declared.kind, recipe?.stack.framework)), ...declared.env },
          reason: "declared in the manifest",
        };
      })
    : inferredDependencies;

  const base: Recipe = recipe ?? {
    stack: { language: "UNKNOWN", buildTool: "NONE" },
    image: "",
    install: [],
    build: [],
    prepare: [],
    port: 8080,
    health: ["/health", "/"],
    startupTimeoutSeconds: 300,
    env: {},
  };
  const overridden = manifest ? Object.keys(manifest).filter((key) => key !== "version" && key !== "root") : [];
  const port = manifest?.port ?? base.port;
  const env = mergeEnv(dependencies, {
    ...base.env,
    ...(manifest?.port ? { SERVER_PORT: String(port), PORT: String(port) } : {}),
    ...manifest?.env,
  });
  const run = manifest?.run ?? base.run;
  if (manifest?.run) {
    const index = unresolved.findIndex((value) => value.field === "run" || value.field === "stack");
    if (index >= 0) unresolved.splice(index, 1);
  }
  const image = manifest?.image ?? base.image;
  if (!image) unresolved.push({ field: "image", reason: "no base image could be chosen for this stack", remediation: 'declare "image" in .autopilot/environment.yml' });
  return environmentPlanSchema.parse({
    planVersion: ENVIRONMENT_PLAN_VERSION,
    root,
    stack: base.stack,
    image,
    install: manifest?.install ?? base.install,
    build: manifest?.build ?? base.build,
    prepare: manifest?.prepare ?? base.prepare,
    ...(run ? { run } : {}),
    port,
    health: manifest?.health ?? base.health,
    startupTimeoutSeconds: manifest?.startupTimeoutSeconds ?? base.startupTimeoutSeconds,
    env,
    dependencies,
    source: !manifest || !overridden.length ? "INFERRED" : recipe ? "MIXED" : "MANIFEST",
    evidence,
    notes,
    unresolved,
  });
}

/** Whether the plan can be executed. An unresolved plan is reported, never run on a guess. */
export function planIsExecutable(plan: EnvironmentPlan): boolean {
  return plan.unresolved.length === 0 && Boolean(plan.run) && Boolean(plan.image);
}

export const environmentPlanToolName = "superadmin_environment_plan";
export const environmentPlanToolDescription =
  "Read-only: decide how the autopilot would build, start and reach a registered GitHub repository's backend in a throwaway environment at one exact commit -- stack, base image, install/build/prepare/run commands (argv), port, health probes and dependency containers such as PostgreSQL or Redis -- with the evidence for each decision, honouring .autopilot/environment.yml. Anything it cannot decide is listed in unresolved with a remediation; an unresolved plan is never executed.";
export const environmentPlanToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const environmentPlanToolInputSchema = {
  projectId: z.string().uuid(),
  resourceId: z.string().uuid(),
  ref: z.string().min(1).max(255).optional().describe("Branch, tag or exact commit SHA; the default branch when omitted"),
  root: z
    .string()
    .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/)
    .optional()
    .describe("The application directory, for a repository that holds several"),
};
