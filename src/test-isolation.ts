// A test launched by absolute path from another directory may skip bunfig.toml.
// Fail before importing any hub code rather than letting fixtures reach the real fleet.
const isolatedChild = process.env.NOOP_HOME && process.env.HUB_DATA && process.env.HUB_SYNC === "local";
if (process.env.NODE_ENV === "test" && !(globalThis as any)[Symbol.for("noop.test.isolated")] && !isolatedChild) {
  throw new Error("Noop tests require test/preload.ts. Run bun test from the repository root or pass --preload /path/to/noop/test/preload.ts.");
}
export {};
