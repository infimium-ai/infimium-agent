export function protectStdioStdout(): void {
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
}
