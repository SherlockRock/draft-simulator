import { describe, expect, it } from "vitest";
import { RPCType } from "@opentelemetry/core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  HTTP_ROUTE_CLASSES,
  classifyHttpRequest,
  seedHttpRouteFallback,
} = require("../../observability/httpRouteAttribution");

function withHttpMetadata(callback, route) {
  const metadata = { type: RPCType.HTTP, route };
  callback(metadata);
  return metadata;
}

describe("HTTP route attribution", () => {
  it.each([
    ["OPTIONS", "/api/teams", HTTP_ROUTE_CLASSES.CORS_PREFLIGHT],
    ["GET", "/socket.io/?EIO=4&transport=polling", HTTP_ROUTE_CLASSES.SOCKET_IO],
    ["POST", "/socket.io/?EIO=4&transport=polling&sid=secret", HTTP_ROUTE_CLASSES.SOCKET_IO],
    ["GET", "/missing/123?token=secret", HTTP_ROUTE_CLASSES.UNMATCHED],
    ["POST", "/api/teams", HTTP_ROUTE_CLASSES.UNMATCHED],
  ])("classifies %s %s as a bounded route", (method, url, expected) => {
    expect(classifyHttpRequest({ method, url })).toBe(expected);
  });

  it("seeds unmatched requests so the HTTP metric receives a route", () => {
    const metadata = withHttpMetadata((rpcMetadata) => {
      seedHttpRouteFallback(
        { method: "GET", url: "/missing/123" },
        rpcMetadata,
      );
    });

    expect(metadata.route).toBe(HTTP_ROUTE_CLASSES.UNMATCHED);
  });

  it("allows Express to replace the fallback with its matched template", () => {
    const metadata = withHttpMetadata((rpcMetadata) => {
      seedHttpRouteFallback(
        { method: "GET", url: "/api/teams/team-123" },
        rpcMetadata,
      );
      // Express instrumentation mutates this same metadata object on a match.
      rpcMetadata.route = "/api/teams/:id";
    });

    expect(metadata.route).toBe("/api/teams/:id");
  });

  it("allows the explicit root health route to replace the fallback", () => {
    const metadata = withHttpMetadata((rpcMetadata) => {
      seedHttpRouteFallback({ method: "GET", url: "/" }, rpcMetadata);
      rpcMetadata.route = "/";
    });

    expect(metadata.route).toBe("/");
  });

  it("does not overwrite an existing matched route", () => {
    const metadata = withHttpMetadata(
      (rpcMetadata) =>
        seedHttpRouteFallback(
          { method: "GET", url: "/api/teams/team-123" },
          rpcMetadata,
        ),
      "/api/teams/:id",
    );

    expect(metadata.route).toBe("/api/teams/:id");
  });
});
