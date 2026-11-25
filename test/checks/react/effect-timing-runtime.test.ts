import { expect, it } from "vitest";

// Independent JavaScript execution controls: these establish expected timing,
// rather than deriving expectations from the lint implementation under test.
it.each(["then", "wrapper"] as const)(
  "preserves helper execution timing via %s",
  async (form) => {
    for (const before of [false, true]) {
      const events: string[] = [];
      const read = async () => {
        if (before) events.push("update");
        await Promise.resolve();
        if (!before) events.push("update");
      };
      events.push("start");
      const pending =
        form === "then"
          ? read().then(() => {})
          : (async () => {
              await read();
            })();
      events.push("return");
      await pending;
      expect(events).toEqual(
        before ? ["start", "update", "return"] : ["start", "return", "update"],
      );
    }
  },
);

it.each(["throw", "reject", "async-throw"] as const)(
  "distinguishes %s error timing",
  async (mode) => {
    const events: string[] = [];
    const request =
      mode === "throw"
        ? () => {
            throw Error("synthetic");
          }
        : mode === "reject"
          ? () => Promise.reject(Error("synthetic"))
          : async () => {
              throw Error("synthetic");
            };
    const read = async () => {
      try {
        await request();
      } catch {
        events.push("update");
      }
    };
    const pending = read();
    events.push("return");
    await pending;
    expect(events).toEqual(
      mode === "throw" ? ["update", "return"] : ["return", "update"],
    );
  },
);

it("suspends before catching rejection caused by thenable assimilation", async () => {
  const events: string[] = [];
  const promise = {
    get then(): never {
      throw Error("synthetic");
    },
  };
  const pending = (async () => {
    try {
      await promise;
    } catch {
      events.push("update");
    }
  })();
  events.push("return");
  await pending;
  expect(events).toEqual(["return", "update"]);
});
