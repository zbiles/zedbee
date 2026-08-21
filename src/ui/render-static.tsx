import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactNode } from "react";

export interface StaticInkOptions {
  readonly width: number;
  readonly stdout?: NodeJS.WriteStream;
}

function writeOnce(stdout: NodeJS.WriteStream, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(output, (error: Error | null | undefined) => {
      if (error == null) resolve();
      else reject(error);
    });
  });
}

export async function renderStaticInk(
  node: ReactNode,
  options: StaticInkOptions,
): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const chunks: Buffer[] = [];
  const sink = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  sink.columns = Math.max(1, options.width);
  sink.rows = stdout.rows ?? 24;
  sink.isTTY = false;
  sink.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const app = render(node, {
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 1,
    stdout: sink as unknown as NodeJS.WriteStream,
  });
  try {
    await app.waitUntilRenderFlush();
  } finally {
    app.unmount();
    await app.waitUntilExit();
  }

  await writeOnce(stdout, Buffer.concat(chunks).toString("utf8"));
}
