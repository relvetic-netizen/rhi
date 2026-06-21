import { Status, type Client } from "discord.js";

/**
 * Build a stricter "is the Discord client actually serving traffic" probe
 * for the HTTP `/health` endpoint.
 *
 * Why not just `client.isReady()`?
 *   isReady() flips true on the first READY gateway dispatch and stays true
 *   until the client is fully destroyed. During short Gateway disconnects
 *   (token rotation, websocket close, mid-reconnect) the ws shard is no
 *   longer serving but isReady() still reports true, so /health would
 *   reassure a load balancer about a daemon that can't actually send.
 *
 * The probe is true only when BOTH:
 *   - ws.status === Status.Ready (0)   — the shard is in the serving state
 *   - ws.ping   >= 0                   — at least one heartbeat round-trip
 *                                        has completed (no shard / never
 *                                        connected returns -1)
 */
export function buildClientReadyProbe(client: Client): () => boolean {
  return () => {
    const ws = client.ws as { status?: Status; ping?: number } | undefined;
    if (!ws) return false;
    if (ws.status !== Status.Ready) return false;
    if (typeof ws.ping !== "number" || ws.ping < 0) return false;
    return true;
  };
}
