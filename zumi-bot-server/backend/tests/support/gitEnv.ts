// The env for git in a test's own repos: none of the user's git config may reach them. GIT_CONFIG_GLOBAL and
// GIT_CONFIG_NOSYSTEM shut out the files; config can also come through the environment (GIT_CONFIG_PARAMETERS, which
// `git -c` and the Claude desktop terminal set, and GIT_CONFIG_COUNT with its KEY_n/VALUE_n pairs), so those are dropped.
// The terminal's `safe.bareRepository=explicit` made git refuse a test's bare "remote" repo.
export function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  return env
}
