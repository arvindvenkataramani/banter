// Re-export from shared — tailscale.ts has moved to control/shared/src/tailscale.ts
export type { RunFn, PollHealthFn, RetryOpts } from "../../shared/src/tailscale";
export { removeTailscaleServe, addTailscaleServe } from "../../shared/src/tailscale";
