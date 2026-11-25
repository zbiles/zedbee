import { isUtf8 } from "node:buffer";

export class InvalidUtf8Error extends Error {
  constructor() {
    super("Zedbee could not read the file as valid UTF-8.");
    this.name = "InvalidUtf8Error";
  }
}

export function decodeLosslessUtf8(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw new InvalidUtf8Error();
  // Buffer decoding retains a literal leading BOM as well as U+FFFD.
  return bytes.toString("utf8");
}
