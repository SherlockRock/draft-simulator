const { context } = require("@opentelemetry/api");
const { getRPCMetadata, RPCType } = require("@opentelemetry/core");

const HTTP_ROUTE_CLASSES = Object.freeze({
  CORS_PREFLIGHT: "CORS_PREFLIGHT",
  SOCKET_IO: "SOCKET_IO",
  UNMATCHED: "UNMATCHED",
});

function classifyHttpRequest(request) {
  if (request.method === "OPTIONS") {
    return HTTP_ROUTE_CLASSES.CORS_PREFLIGHT;
  }

  // Match only Engine.IO's fixed mount point. Never use the raw URL as a
  // route label: it may contain query strings, IDs, or other unbounded data.
  const pathname = request.url?.split("?", 1)[0];
  if (pathname === "/socket.io" || pathname?.startsWith("/socket.io/")) {
    return HTTP_ROUTE_CLASSES.SOCKET_IO;
  }

  return HTTP_ROUTE_CLASSES.UNMATCHED;
}

function seedHttpRouteFallback(
  request,
  rpcMetadata = getRPCMetadata(context.active()),
) {
  if (rpcMetadata?.type === RPCType.HTTP && rpcMetadata.route === undefined) {
    rpcMetadata.route = classifyHttpRequest(request);
  }
}

module.exports = {
  HTTP_ROUTE_CLASSES,
  classifyHttpRequest,
  seedHttpRouteFallback,
};
