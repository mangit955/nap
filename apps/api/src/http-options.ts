// A lazy desktop start and its credential command can outlast Bun's 10-second HTTP idle default.
export const HTTP_SERVER_OPTIONS = { idleTimeout: 120 };
