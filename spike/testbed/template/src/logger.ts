export function log(level: "debug" | "info" | "error", message: string): void {
  console.log(`[${level}] ${message}`);
}
