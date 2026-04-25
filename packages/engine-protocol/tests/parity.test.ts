import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EngineRequestSchema, EngineResponseSchema } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("schema parity", () => {
  it("request_fixture_round_trips", () => {
    const raw = JSON.parse(readFileSync(join(here, "fixtures/sample-request.json"), "utf8"));
    const parsed = EngineRequestSchema.parse(raw);
    const reSerialized = JSON.parse(JSON.stringify(parsed));
    expect(reSerialized).toEqual(raw);
  });

  it("response_fixture_round_trips", () => {
    const raw = JSON.parse(readFileSync(join(here, "fixtures/sample-response.json"), "utf8"));
    const parsed = EngineResponseSchema.parse(raw);
    const reSerialized = JSON.parse(JSON.stringify(parsed));
    expect(reSerialized).toEqual(raw);
  });
});
