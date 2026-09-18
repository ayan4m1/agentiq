// imported for its side effect alone, and imported first by config.ts. putting
// the call at the top of that file only looked like it ran before anything
// else: ESM evaluates every import declaration before any module body, so the
// env would have been read after them rather than before
try {
  process.loadEnvFile();
} catch {
  // If there is no .env file, use the environment as-is
}
