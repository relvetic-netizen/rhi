/**
 * Fix DNS resolution for undici (Node.js built-in fetch / Discord.js REST).
 * System IPv6 DNS may timeout; force IPv4 resolution via Google DNS.
 * Must be imported before any Discord.js or fetch usage.
 */
import dns from "dns";
import { Agent, setGlobalDispatcher } from "undici";

const servers = (process.env.DNS_SERVERS || "8.8.8.8,8.8.4.4").split(",").map(s => s.trim()).filter(Boolean);
dns.setServers(servers);
dns.setDefaultResultOrder("ipv4first");

const agent = new Agent({
  connect: {
    lookup(hostname: string, options: dns.LookupOptions, callback: Function) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (options?.all) {
        dns.resolve4(hostname, (err, addresses) => {
          if (err) return callback(err);
          callback(
            null,
            addresses.map((a) => ({ address: a, family: 4 }))
          );
        });
      } else {
        dns.resolve4(hostname, (err, addresses) => {
          if (err) return callback(err);
          callback(null, addresses[0], 4);
        });
      }
    },
  },
});

setGlobalDispatcher(agent);
