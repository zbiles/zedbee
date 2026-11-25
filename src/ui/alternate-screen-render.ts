export const CURSOR_HOME = "\u001b[H";
export const SGR_MOUSE_REPORT = /(?:\u001b)?\[<\d+;\d+;\d+[Mm]/u;

export function alternateScreenRenderOptions(maxFps: number) {
  let homeTemporaryScreen = true;
  return Object.freeze({
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps,
    alternateScreen: true,
    onRender() {
      if (!homeTemporaryScreen) return;
      homeTemporaryScreen = false;
      process.stdout.write(CURSOR_HOME);
    },
  });
}
