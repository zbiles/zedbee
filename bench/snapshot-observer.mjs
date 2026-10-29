// Benchmark-only preloader. The measured CLI and its ordinary command executor
// still run; instrumentation observes actual cache reads and service requests.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.ZEDBEE_BENCH_IMPLEMENTATION;
const output = process.env.ZEDBEE_BENCH_OBSERVATIONS;
if (!root || !output)
  throw new Error("Missing benchmark observer configuration");
const load = (path) => import(pathToFileURL(join(root, "dist", path)).href);
const counters = {
  pid: process.pid,
  gets: 0,
  hits: 0,
  sets: 0,
  serviceSessions: 0,
};
const { ObservationCacheStore } = await load("cache/store.js");
const get = ObservationCacheStore.prototype.get;
const set = ObservationCacheStore.prototype.set;
ObservationCacheStore.prototype.get = async function (...args) {
  counters.gets++;
  if (process.env.ZEDBEE_BENCH_CACHE === "off") return undefined;
  const value = await get.apply(this, args);
  if (value !== undefined) counters.hits++;
  return value;
};
ObservationCacheStore.prototype.set = async function (...args) {
  counters.sets++;
  if (process.env.ZEDBEE_BENCH_CACHE !== "off") return set.apply(this, args);
};
const { ServiceClient } = await load("service/client.js");
const request = ServiceClient.prototype.request;
ServiceClient.prototype.request = function (operation, ...args) {
  if (operation === "open") counters.serviceSessions++;
  return request.call(this, operation, ...args);
};
process.once("exit", () => {
  writeFileSync(
    output,
    JSON.stringify({
      ...counters,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});
