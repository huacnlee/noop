import { expect, test } from "bun:test";
import { FallbackModel, type Model } from "../src/brain";

const fake = (name: string, failAt: number, log: string[]): Model => ({
  async open() {
    let n = 0;
    return {
      send: async (t: string) => { log.push(`${name}:${t}`); if (++n === failAt) throw new Error("model timeout"); return `${name}:${t}`; },
      close: () => {},
    };
  },
});

test("a failing chat model hands the conversation to the next one, replaying earlier turns", async () => {
  const log: string[] = [];
  const fell: number[] = [];
  const conv = await new FallbackModel([fake("haiku", 2, log), fake("sonnet", 0, log)], (i) => fell.push(i)).open("sys");
  expect(await conv.send("a")).toBe("haiku:a");
  expect(await conv.send("b")).toBe("sonnet:b");
  expect(log).toEqual(["haiku:a", "haiku:b", "sonnet:a", "sonnet:b"]);
  expect(fell).toEqual([0]);
});

test("when every model fails the error reaches the caller", async () => {
  const conv = await new FallbackModel([fake("a", 1, []), fake("b", 1, [])]).open("sys");
  expect(conv.send("x")).rejects.toThrow("model timeout");
});
