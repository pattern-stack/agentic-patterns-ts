#!/usr/bin/env node
import { stdin } from "node:process";

const eventName = process.argv[2] ?? "Unknown";
const base = process.env.AP_DASHBOARD_URL ?? "http://localhost:3000";

try {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8") || "{}";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);

  await fetch(`${base}/hooks/${eventName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: controller.signal,
  }).catch((err) => {
    process.stderr.write(`[ap-hook] ${eventName}: ${err.message ?? err}\n`);
  });

  clearTimeout(timer);
} catch (err) {
  process.stderr.write(`[ap-hook] ${eventName}: ${err?.message ?? err}\n`);
}

process.exit(0);
