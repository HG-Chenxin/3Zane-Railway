import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedQueue } from "./bounded-queue.mjs";

test("serializes tasks and runs them in FIFO order", async () => {
  const queue = createBoundedQueue({ concurrency: 1, maxQueued: 2 });
  const order = [];
  let releaseFirst;
  const first = queue(() => new Promise((resolve) => {
    order.push("first");
    releaseFirst = resolve;
  }));
  const second = queue(() => order.push("second"));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("rejects work when the bounded waiting queue is full", async () => {
  const queue = createBoundedQueue({ concurrency: 1, maxQueued: 1 });
  let releaseFirst;
  const first = queue(() => new Promise((resolve) => { releaseFirst = resolve; }));
  const second = queue(() => undefined);
  await assert.rejects(queue(() => undefined), { status: 503 });

  releaseFirst();
  await Promise.all([first, second]);
});
