import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { z } from "zod";
import { EngineRequestSchema } from "../schemas/request.js";
import { EngineResponseSchema } from "../schemas/response.js";
import { EngineErrorSchema } from "../schemas/protocol.js";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../schema.json");

function toJsonValue(input: unknown): JsonValue {
  // z.toJSONSchema returns a Zod-typed object. Round-tripping through JSON
  // both validates the result is JSON-shaped and gives us a JsonValue back.
  const text: string = JSON.stringify(input);
  const parsed: JsonValue = JSON.parse(text);
  return parsed;
}

// Zod 4 emits recursive types using nested `$defs` / `$ref: "#/$defs/__schemaN"`.
// typify (Phase 2) expects refs at the workspace top-level `#/definitions/...`.
// This walker hoists every nested $defs into a single top-level definitions map
// and rewrites refs accordingly.
function relocateDefs(node: JsonValue, sink: JsonObject): JsonValue {
  if (Array.isArray(node)) {
    return node.map((entry) => relocateDefs(entry, sink));
  }
  if (node !== null && typeof node === "object") {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs" && value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [defName, defSchema] of Object.entries(value)) {
          if (!(defName in sink)) {
            sink[defName] = relocateDefs(defSchema, sink);
          }
        }
        continue;
      }
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
        result.$ref = value.replace("#/$defs/", "#/definitions/");
        continue;
      }
      result[key] = relocateDefs(value, sink);
    }
    return result;
  }
  return node;
}

const sharedDefs: JsonObject = {};
const engineRequest = relocateDefs(toJsonValue(z.toJSONSchema(EngineRequestSchema)), sharedDefs);
const engineResponse = relocateDefs(toJsonValue(z.toJSONSchema(EngineResponseSchema)), sharedDefs);
const engineError = relocateDefs(toJsonValue(z.toJSONSchema(EngineErrorSchema)), sharedDefs);

// Zod 4 auto-names recursive types (`__schema0`, `__schema1`...) — rename the
// well-known TreeNode shape so typify produces a usable `TreeNode` struct
// instead of `Schema0`. The only recursion in the v1 protocol is TreeNode;
// add explicit cases here if more recursive types appear.
const renamed: JsonObject = {};
for (const [defName, defSchema] of Object.entries(sharedDefs)) {
  const target = defName === "__schema0" ? "TreeNode" : defName;
  renamed[target] = defSchema;
}

const combined = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "engine-protocol",
  definitions: {
    ...renamed,
    EngineRequest: engineRequest,
    EngineResponse: engineResponse,
    EngineError: engineError,
  },
};

const serialized = JSON.stringify(combined, null, 2).replaceAll(
  '"#/definitions/__schema0"',
  '"#/definitions/TreeNode"',
);

writeFileSync(out, serialized);
console.log(`schema.json written to ${out}`);
