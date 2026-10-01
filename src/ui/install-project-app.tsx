import { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import type { InitPromptOptions } from "../commands/init.js";
import type { ProjectInstallTarget } from "../init/install-project.js";
import {
  BrandedCommandFrame,
  BrandedCommandPanel,
  brandedCommandContentWidth,
} from "./branded-command-frame.js";
import { initRenderOptions } from "./init-app.js";
import { PlainWordmark } from "./pixel-wordmark.js";
import { TerminalViewport } from "./terminal-viewport.js";
import { colorProp, ZEDBEE_THEME } from "./theme.js";

export interface InstallProjectAppProps {
  readonly targets: readonly ProjectInstallTarget[];
  readonly width: number;
  readonly color: boolean;
  readonly signal?: AbortSignal;
  install(target: ProjectInstallTarget, signal: AbortSignal): Promise<void>;
  onDecision(installed: boolean): void;
}

export function InstallProjectApp({
  targets,
  width,
  color,
  signal,
  install,
  onDecision,
}: InstallProjectAppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns ?? width;
  const rows = size.rows ?? 40;
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  const canceled = useRef(false);
  const target = targets[selected]!;
  const finish = (installed: boolean) => {
    onDecision(installed);
    exit();
  };
  useEffect(() => {
    const cancel = () => {
      canceled.current = true;
      if (operation.current !== null) operation.current.abort();
      else finish(false);
    };
    if (signal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    return () => {
      signal?.removeEventListener("abort", cancel);
      operation.current?.abort();
    };
  }, [signal]);
  useInput((input, key) => {
    if (
      key.escape ||
      (key.ctrl && input.toLowerCase() === "c") ||
      input === "\u0003"
    ) {
      canceled.current = true;
      if (operation.current !== null) operation.current.abort();
      else finish(false);
      return;
    }
    if (key.pageDown || key.pageUp) {
      setOffset((value) => Math.max(0, value + (key.pageDown ? 10 : -10)));
      return;
    }
    if (busy) return;
    if (key.upArrow || key.downArrow) {
      setSelected(
        (value) =>
          (value + (key.downArrow ? 1 : -1) + targets.length) % targets.length,
      );
      setError(undefined);
    } else if (key.return && operation.current === null) {
      const controller = new AbortController();
      operation.current = controller;
      setBusy(true);
      setError(undefined);
      void install(target, controller.signal)
        .then(() => finish(!canceled.current))
        .catch((cause: unknown) => {
          if (canceled.current) {
            finish(false);
            return;
          }
          setError(
            cause instanceof Error ? cause.message : "Installation failed.",
          );
        })
        .finally(() => {
          operation.current = null;
          setBusy(false);
        });
    }
  });
  const count = Math.max(2, rows - 29);
  const start = Math.max(0, Math.min(selected, targets.length - count));
  const panel = (
    <BrandedCommandPanel
      title="PROJECT FOLDER"
      width={brandedCommandContentWidth(columns)}
      color={color}
    >
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>Choose the project folder for Zedbee.</Text>
        <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
          Zedbee will be installed in the selected project.
        </Text>
        <Box flexDirection="column" marginY={1}>
          {targets.slice(start, start + count).map((item) => (
            <Text
              key={item.projectRoot}
              bold={item === target}
              {...colorProp(
                color,
                item === target ? ZEDBEE_THEME.yellow : ZEDBEE_THEME.primary,
              )}
            >
              {item === target ? "➜" : " "}{" "}
              {item.projectRoot === "." ? "Repository root" : item.projectRoot}
              {item.hasPrettier ? "  · Prettier detected" : ""}
            </Text>
          ))}
        </Box>
        {busy ? (
          <Box marginTop={1}>
            <Text {...colorProp(color, ZEDBEE_THEME.yellow)}>
              Preparing {target.projectRoot}...
            </Text>
          </Box>
        ) : null}
        {error === undefined ? null : (
          <Box flexDirection="column" marginTop={1}>
            <Text>Could not prepare this project</Text>
            <Text>{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text {...colorProp(color, ZEDBEE_THEME.secondary)}>
            {busy
              ? "Esc Cancel"
              : "↑ ↓ Select folder · Enter Continue · Esc Cancel"}
          </Text>
        </Box>
      </Box>
    </BrandedCommandPanel>
  );
  return (
    <TerminalViewport
      width={columns}
      height={rows}
      offset={offset}
      color={color}
      onOffsetChange={setOffset}
    >
      {rows < 36 ? (
        <Box flexDirection="column" paddingX={1}>
          <PlainWordmark color={color} />
          {panel}
        </Box>
      ) : (
        <BrandedCommandFrame width={columns} color={color}>
          {panel}
        </BrandedCommandFrame>
      )}
    </TerminalViewport>
  );
}

export async function runProjectInstallPrompt(
  targets: readonly ProjectInstallTarget[],
  options: InitPromptOptions & { readonly signal?: AbortSignal },
  install: InstallProjectAppProps["install"],
): Promise<boolean> {
  let installed = false;
  const app = render(
    <InstallProjectApp
      targets={targets}
      {...options}
      install={install}
      onDecision={(value) => {
        installed = value;
      }}
    />,
    initRenderOptions(),
  );
  await app.waitUntilExit();
  return installed;
}
