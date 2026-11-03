import http from "node:http";
import type { AddressInfo } from "node:net";
import { XLSX_MIME } from "../src/content/xlsx.js";

/**
 * POST headers plus the start of a body that never ends; resolves with the response status. Proves a route answers before
 * reading the body (the pre-auth upload reader). `server` is the app's http server, listening.
 */
export function unfinishedUpload(
  server: unknown,
  headers: Record<string, string>,
  path = "/v1/admin/content/aircraft-identifier-military/imports",
  contentType = XLSX_MIME,
): Promise<number> {
  const { port } = (server as { address(): AddressInfo }).address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { ...headers, "Content-Type": contentType, "Content-Length": String(50 * 1024 * 1024) } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      },
    );
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.write(Buffer.alloc(1024)); // headers go out; the other 50 MB never does
  });
}
