// Re-export from shared — tailscale.ts has moved to control/shared/src/tailscale.ts
export type { RunFn, PollHealthFn } from "../../shared/src/tailscale";
export { removeTailscaleServe, addTailscaleServe } from "../../shared/src/tailscale";
