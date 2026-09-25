// Which of the shard process's two Hono apps sees a request.
//
// sharedApp carries the routes every node has; shardApp the ones only a
// shard has. A route registered on shardApp but not matched by
// routesToShardApp is unreachable — it falls through to sharedApp, which
// 404s it, with nothing in the shard's own logs to say why.
//
// These live apart from index.ts because that module boots a shard on
// import: binding a port, loading a registry, starting loops. Path
// predicates are the one piece of that wiring worth testing on its own.

export function isPlatformPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/status" || pathname.startsWith("/ping/");
}

export function routesToShardApp(pathname: string): boolean {
  return (
    pathname === "/status" ||
    pathname.startsWith("/ping/") ||
    (pathname.startsWith("/api/services/") && (pathname.endsWith("/start") || pathname.endsWith("/stop"))) ||
    pathname === "/api/roster" ||
    pathname === "/api/config/reload"
  );
}
