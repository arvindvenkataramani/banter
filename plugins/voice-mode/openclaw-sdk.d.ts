// Ambient shim for the OpenClaw plugin SDK. The real module is provided by
// the gateway at load time (via its module loader), so it is never installed
// in this package's node_modules and tsc cannot resolve it.
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry<T>(entry: T): T;
}
