/**
 * Network — placeholder until the network subsystem lands (Phase 4): direct
 * networking, tunnels (cloudflared/playit/ngrok/tailscale), and Cloudflare DNS.
 */

import { Placeholder } from "../shared.tsx";

export function Network() {
  return (
    <Placeholder
      title="Network"
      phase="Phase 4"
      note="Per-server profiles, tunnel status, join address, and Cloudflare DNS."
    />
  );
}
