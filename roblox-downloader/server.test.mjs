import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const downloaderDir = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = pathToFileURL(path.join(downloaderDir, "server.mjs")).href;

async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  const port = await reservePort();
  const runtimeDir = path.join(downloaderDir, ".test-runtime", `${process.pid}-${randomUUID()}`);
  const preload = `
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://assetdelivery.roblox.com/")) {
        throw new Error("Unexpected upstream request");
      }
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        }
      });
      const response = new Response(body, { status: 200 });
      response.arrayBuffer = async () => { throw new Error("Whole-body allocation attempted"); };
      return response;
    };
    await import(${JSON.stringify(serverUrl)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", preload], {
    cwd: downloaderDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MAX_BYTES: "8",
      CACHE_DIR: path.join(runtimeDir, "cache"),
      MUSIC_DIR: path.join(runtimeDir, "music"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Downloader exited early:\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          await response.arrayBuffer();
          return {
            baseUrl,
            async close() {
              child.kill();
              await new Promise((resolve) => child.once("exit", resolve));
              await rm(runtimeDir, { recursive: true, force: true });
            },
          };
        }
      } catch {
        // Retry until the child binds its local port.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Downloader did not become ready:\n${output}`);
  } catch (error) {
    child.kill();
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

test("oversized JSON gets HTTP 413 and downloads are capped while streaming", async () => {
  const server = await startServer();
  try {
    const rootResponse = await fetch(`${server.baseUrl}/`);
    assert.equal(rootResponse.status, 404);
    assert.deepEqual(await rootResponse.json(), { error: "Not found" });

    const unknownPathResponse = await fetch(`${server.baseUrl}/unknown`);
    assert.equal(unknownPathResponse.status, 404);
    assert.deepEqual(await unknownPathResponse.json(), { error: "Not found" });

    const oversizedBody = Buffer.alloc(64 * 1024 + 1, 0x20);
    const oversizedResponse = await fetch(`${server.baseUrl}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    assert.equal(oversizedResponse.status, 413);
    assert.deepEqual(await oversizedResponse.json(), { error: "Payload terlalu besar" });

    const downloadResponse = await fetch(`${server.baseUrl}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: "123", cookie: "valid-cookie", placeId: "456" }),
    });
    assert.equal(downloadResponse.status, 413);
    assert.deepEqual(await downloadResponse.json(), {
      error: "File melebihi batas ukuran server",
      code: "TOO_LARGE",
    });
  } finally {
    await server.close();
  }
});
