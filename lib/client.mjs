import { createHash } from "node:crypto";

export class DeployError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createClient({ url, token, fetchImpl = fetch, retries = 3 }) {
  const endpoint = (action, params = {}) => {
    const target = new URL(url);
    target.searchParams.set("action", action);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    return target;
  };

  const call = async (action, { params, json, body } = {}) => {
    const headers = { "X-Releaseflip-Token": token, Authorization: `Bearer ${token}` };
    let payload = body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
    }
    let response;
    try {
      response = await fetchImpl(endpoint(action, params), { method: "POST", headers, body: payload });
    } catch (error) {
      throw new DeployError(`Could not reach ${url} (${error.cause?.code || error.message}).`, "network", 0);
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const hint = response.status === 404 ? " Is releaseflip.php uploaded to that address?" : "";
      throw new DeployError(`The server answered ${response.status} without releaseflip JSON.${hint}`, "not_releaseflip", response.status);
    }
    if (!response.ok || !data.ok) {
      const error = new DeployError(data.message || `Request failed with ${response.status}.`, data.error || "failed", response.status);
      error.data = data;
      throw error;
    }
    return data;
  };

  const sendPackage = async (zip, onProgress = () => {}) => {
    const sha256 = createHash("sha256").update(zip).digest("hex");
    const started = await call("begin", { json: { size: zip.length, sha256 } });
    const size = started.chunk_bytes;
    let offset = 0;
    while (offset < zip.length) {
      const chunk = zip.subarray(offset, offset + size);
      let attempt = 0;
      for (;;) {
        try {
          const result = await call("chunk", { params: { upload: started.upload, offset }, body: chunk });
          offset = result.received;
          break;
        } catch (error) {
          if (error.code === "out_of_order" && error.data?.received === offset + chunk.length) {
            offset = error.data.received;
            break;
          }
          attempt += 1;
          if (error.code !== "network" || attempt > retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
      onProgress(offset, zip.length);
    }
    return { upload: started.upload, sha256 };
  };

  return {
    ping: () => call("ping"),
    list: () => call("list"),
    rollback: (to) => call("rollback", { json: to ? { to } : {} }),
    deploy: async (zip, onProgress) => {
      const { upload, sha256 } = await sendPackage(zip, onProgress);
      const result = await call("finish", { params: { upload } });
      return { ...result, sha256 };
    }
  };
}
