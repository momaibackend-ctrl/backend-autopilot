// Parity self-test fixture: the same notes API with ONE behavioural difference -- reading a note
// also returns `archived`. A parity run against the original must report exactly that.
// Self-test fixture: a notes API that only works when a real PostgreSQL is reachable through
// DATABASE_URL. If the environment does not provision and wire the database, it cannot start.
const http = require("node:http");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(value === undefined ? "" : JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function main() {
  await pool.query("CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, title text NOT NULL)");
  http
    .createServer(async (request, response) => {
      try {
        const url = new URL(request.url, "http://fixture");
        if (request.method === "GET" && url.pathname === "/health") {
          await pool.query("SELECT 1");
          return send(response, 200, { status: "UP" });
        }
        if (request.method === "GET" && url.pathname === "/notes") {
          const { rows } = await pool.query("SELECT id, title FROM notes ORDER BY id");
          return send(response, 200, rows);
        }
        if (request.method === "POST" && url.pathname === "/notes") {
          const input = await body(request);
          if (typeof input.title !== "string" || !input.title) return send(response, 400, { error: "title is required" });
          const { rows } = await pool.query("INSERT INTO notes (title) VALUES ($1) RETURNING id, title", [input.title]);
          return send(response, 201, rows[0]);
        }
        const match = /^\/notes\/(\d+)$/.exec(url.pathname);
        if (match && request.method === "GET") {
          const { rows } = await pool.query("SELECT id, title FROM notes WHERE id = $1", [Number(match[1])]);
          return rows[0] ? send(response, 200, { ...rows[0], archived: false }) : send(response, 404, { error: "not found" });
        }
        if (match && request.method === "DELETE") {
          const { rowCount } = await pool.query("DELETE FROM notes WHERE id = $1", [Number(match[1])]);
          return rowCount ? send(response, 204) : send(response, 404, { error: "not found" });
        }
        return send(response, 404, { error: "not found" });
      } catch (error) {
        return send(response, 500, { error: String(error && error.message) });
      }
    })
    .listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
