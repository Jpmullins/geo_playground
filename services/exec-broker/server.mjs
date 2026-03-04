import http from "node:http";
import { URL } from "node:url";
import { execFile } from "node:child_process";

const port = Number(process.env.PORT || 8081);
const timeoutMs = Number(process.env.CMD_TIMEOUT_MS || 10000);
const maxOutputBytes = Number(process.env.MAX_OUTPUT_BYTES || 16384);

const denyRules = [
  /\bdocker\b/i,
  /\bpodman\b/i,
  /\bkubectl\b/i,
  /\bapt\b|\bapk\b|\bdnf\b|\byum\b/i,
  /\bsudo\b/i,
  /\bmount\b|\bumsount\b/i,
  /\biptables\b|\bnft\b/i
];

const server = http.createServer(async (req, res) => {
  withCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { service: "exec-broker", status: "ok" });
  }

  if (req.method === "POST" && url.pathname === "/tool/exec") {
    const body = await readJson(req);
    const command = String(body?.command || "").trim();
    const sessionId = String(body?.session_id || "unknown");

    if (!command) {
      return json(res, 400, { error: "command_required" });
    }

    const blockedBy = denyRules.find((rule) => rule.test(command));
    if (blockedBy) {
      return json(res, 403, {
        error: "command_blocked",
        session_id: sessionId,
        policy_flags: ["deny_rule_triggered"]
      });
    }

    const result = await runShell(command, timeoutMs, maxOutputBytes);
    return json(res, 200, {
      session_id: sessionId,
      ...result
    });
  }

  return json(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(`exec-broker listening on :${port}`);
});

function runShell(command, timeout, maxBytes) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", command], {
      timeout,
      maxBuffer: maxBytes,
      cwd: "/tmp"
    }, (error, stdout, stderr) => {
      const flags = [];
      if (error?.killed) {
        flags.push("timeout");
      }
      if ((stdout?.length || 0) + (stderr?.length || 0) >= maxBytes) {
        flags.push("output_truncated");
      }

      resolve({
        exit_code: error?.code ?? 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        truncated: flags.includes("output_truncated"),
        policy_flags: flags
      });
    });
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        return resolve({});
      }
      try {
        return resolve(JSON.parse(data));
      } catch {
        return resolve({});
      }
    });
  });
}

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
