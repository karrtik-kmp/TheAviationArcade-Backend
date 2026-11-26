import { isIPv4, isIPv6 } from "node:net";

/**
 * The per-IP bucket of a client address (docs/plans/guest-callsign.md G3). IPv4 as is; an IPv4-mapped IPv6 address as its IPv4; any
 * other IPv6 address as its /64 (one subscriber usually holds a whole /64), lower-case and fully expanded. A zone id is dropped.
 * Anything unparseable (or no address at all) shares one fixed bucket, so it can never escape the limit.
 */
export function ipBucket(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.split("%")[0]!.toLowerCase();
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  const groups = expandIPv6(address);
  if (groups[0] === "0000" && groups[1] === "0000" && groups[2] === "0000" && groups[3] === "0000" && groups[4] === "0000" && groups[5] === "ffff") {
    // ::ffff:a.b.c.d written in hex groups.
    const high = Number.parseInt(groups[6]!, 16);
    const low = Number.parseInt(groups[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** Eight 4-digit hex groups. Input is a valid IPv6 address (isIPv6), possibly with an embedded IPv4 tail. */
function expandIPv6(address: string): string[] {
  let text = address;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4?.[1]) {
    const [a, b, c, d] = v4[1].split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((group) => group.padStart(4, "0"));
}
