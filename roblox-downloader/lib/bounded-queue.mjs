export function createBoundedQueue({ concurrency, maxQueued }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Queue concurrency must be a positive integer.");
  }
  if (!Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new RangeError("Queue capacity must be a non-negative integer.");
  }

  let active = 0;
  const waiting = [];

  function drain() {
    while (active < concurrency && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    if (active >= concurrency && waiting.length >= maxQueued) {
      reject(Object.assign(new Error("Server sedang sibuk. Antrean penuh, coba lagi sebentar."), { status: 503 }));
      return;
    }
    waiting.push({ task, resolve, reject });
    drain();
  });
}
