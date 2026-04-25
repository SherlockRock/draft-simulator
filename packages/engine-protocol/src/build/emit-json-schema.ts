import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { z } from "zod";
import { EngineRequestSchema } from "../schemas/request.js";
import { EngineResponseSchema } from "../schemas/response.js";
import { EngineErrorSchema } from "../schemas/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../schema.json");

const combined = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "engine-protocol",
  definitions: {
    EngineRequest: z.toJSONSchema(EngineRequestSchema),
    EngineResponse: z.toJSONSchema(EngineResponseSchema),
    EngineError: z.toJSONSchema(EngineErrorSchema),
  },
};

writeFileSync(out, JSON.stringify(combined, null, 2));
console.log(`schema.json written to ${out}`);
