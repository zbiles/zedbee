import { aroundEach } from "vitest";
import { runWithTestSignal } from "./helpers/current-test-signal.js";

aroundEach((runTest, context) => runWithTestSignal(context.signal, runTest));
