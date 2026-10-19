// Commit hooks export GIT_DIR and GIT_INDEX_FILE. Inheriting them makes a fixture
// operate on the developer's checkout even when its cwd is a temporary directory.
export function localGitEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "Nap Test",
    GIT_CONFIG_KEY_2: "user.email",
    GIT_CONFIG_VALUE_2: "test@nap.dev",
  };
}
