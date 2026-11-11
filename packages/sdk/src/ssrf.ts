/**
 * SSRF protection for user-supplied RPC endpoints.
 *
 * Two layers:
 *  1. assertPublicRpcUrl(): static checks + DNS resolution of ALL addresses at registration time.
 *  2. createGuardedFetch(): re-validates the IP actually being connected to on EVERY connection
 *     (undici connect-time lookup hook). This defeats DNS rebinding, where a hostname resolves
 *     to a public IP at registration and to 127.0.0.1 / 169.254.169.254 later.
 * Redirects are refused by rpcCall (`redirect: "error"`), so a public endpoint cannot bounce us inward.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { SentinelUrlRejectedError } from "./errors.js";
import type { FetchLike } from "./rpc.js";

export interface GuardOptions {
  /** Allow plain http:// (default false). */
  allowHttp?: boolean;
  /** Allowed ports (default 443, 80, 3030, 8080, 8545). */
  allowedPorts?: number[];
  /** Escape hatch for local development ONLY (e.g. the fault-injection proxy). Default false. */
  allowPrivateNetworks?: boolean;
}

const DEFAULT_PORTS = [443, 80, 3030, 8080, 8545];

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  // ipaddr classifies loopback, private, linkLocal (incl. 169.254.169.254 metadata), uniqueLocal,
  // carrierGradeNat, reserved, multicast, broadcast, unspecified, 6to4/teredo etc. Only "unicast" is public.
  return addr.range() === "unicast";
}

export async function assertPublicRpcUrl(raw: string, opts: GuardOptions = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SentinelUrlRejectedError("Not a valid URL");
  }
  if (raw.length > 2048) throw new SentinelUrlRejectedError("URL too long");
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
    throw new SentinelUrlRejectedError(`Protocol ${u.protocol} not allowed (https only)`);
  }
  if (u.username || u.password) throw new SentinelUrlRejectedError("Credentials in URL are not allowed; use headers");
  // Local-development escape hatch (e.g. the fault-injection proxy on an ephemeral port).
  // Protocol and credential rules above still apply.
  if (opts.allowPrivateNetworks) return u;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!(opts.allowedPorts ?? DEFAULT_PORTS).includes(port)) throw new SentinelUrlRejectedError(`Port ${port} not allowed`);

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    throw new SentinelUrlRejectedError("Internal hostnames are not allowed");
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SentinelUrlRejectedError(`Address ${host} is not a public unicast address`);
    return u;
  }
  // Reject numeric-ish hostnames that some resolvers interpret as IPs (e.g. "2130706433", "0x7f.1").
  if (/^[0-9.x]+$/i.test(host)) throw new SentinelUrlRejectedError("Ambiguous numeric hostname");
  let addrs: LookupAddress[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SentinelUrlRejectedError(`Hostname ${host} does not resolve`);
  }
  if (!addrs.length) throw new SentinelUrlRejectedError(`Hostname ${host} does not resolve`);
  const bad = addrs.find((a) => !isPublicAddress(a.address));
  if (bad) throw new SentinelUrlRejectedError(`Hostname ${host} resolves to non-public address ${bad.address}`);
  return u;
}

/** fetch() that refuses to connect to non-public IPs, checked at connection time. */
export function createGuardedFetch(opts: GuardOptions = {}): FetchLike {
  if (opts.allowPrivateNetworks) return (u, i) => fetch(u, i);
  const agent = new Agent({
    connect: {
      lookup(hostname: string, options: any, cb: any) {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses: any) => {
          if (err) return cb(err);
          const list: LookupAddress[] = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family ?? 4 }];
          const bad = list.find((a) => !isPublicAddress(a.address));
          if (bad) return cb(new SentinelUrlRejectedError(`Blocked connection to non-public address ${bad.address}`));
          if (options?.all) return cb(null, list);
          cb(null, list[0]!.address, list[0]!.family);
        });
      },
    },
    bodyTimeout: 30_000,
    headersTimeout: 30_000,
  });
  return async (url, init) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host)) throw new SentinelUrlRejectedError(`Blocked non-public address ${host}`);
    return undiciFetch(url, { ...(init as any), dispatcher: agent }) as unknown as Response;
  };
}
