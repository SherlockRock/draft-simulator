import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { EngineRequest, EngineOutput } from "./types.js";

export const ENGINE_VERSION = "0.1.0";
export type * from "./types.js";

interface Engine {
  compute(request: EngineRequest): Promise<EngineOutput>;
  terminate(): void;
}

export function createEngine(): Engine {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(__dirname, "worker.js");

  let worker = new Worker(workerPath);
  let pending: {
    resolve: (value: EngineOutput) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  worker.on("message", (output: EngineOutput) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(output);
      pending = null;
    }
  });

  worker.on("error", (err) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      pending = null;
    }
  });

  return {
    compute(request: EngineRequest): Promise<EngineOutput> {
      return new Promise((resolve, reject) => {
        if (pending) {
          reject(new Error("Engine is busy - only one computation at a time"));
          return;
        }

        const timeoutMs = request.config.latencyBudgetMs * 1.5;
        const timer = setTimeout(() => {
          pending = null;
          worker.terminate();
          worker = new Worker(workerPath);
          reject(new Error(`Engine timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pending = { resolve, reject, timer };
        worker.postMessage(request);
      });
    },

    terminate(): void {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Engine terminated"));
        pending = null;
      }
      worker.terminate();
    },
  };
}
