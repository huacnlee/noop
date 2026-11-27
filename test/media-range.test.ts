import { expect, test } from "bun:test";
import { mediaResponse } from "../cloud/src/uploads";

test("media probes and seeks return the requested bytes", async () => {
  const blob = new Blob(["abcdef"]);
  for (const [range, status, contentRange, body] of [
    ["bytes=0-1", 206, "bytes 0-1/6", "ab"],
    ["bytes=4-", 206, "bytes 4-5/6", "ef"],
    ["bytes=-3", 206, "bytes 3-5/6", "def"],
    ["bytes=6-", 416, "bytes */6", ""],
  ] as const) {
    const response = mediaResponse(new Request("http://localhost/video", { headers: { range } }), blob, "video/mp4", "video.mp4");
    expect(response.status).toBe(status);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(await response.text()).toBe(body);
  }
});
