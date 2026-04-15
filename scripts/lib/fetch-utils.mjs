import { writeFileSync, readFileSync } from "fs";

export async function fetchJson(url, label) {
  console.log(`  Fetching ${label}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${label}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchJsonBatch(requests, concurrency = 10) {
  const results = [];
  for (let i = 0; i < requests.length; i += concurrency) {
    const batch = requests.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ url, label }) => {
        const data = await fetchJson(url, label);
        return { label, data };
      })
    );
    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({ label: batch[j].label, data: null, error: result.reason.message });
      }
    }
  }
  return results;
}

export function normalize(name) {
  return name.toLowerCase().replace(/[\s'`.&]/g, "");
}

export function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  Wrote ${filePath}`);
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}
