# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bishnopaul/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bishnopaul/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only — no git binary, no database, no UI. It serves git smart HTTP (upload-pack protocol v2 and v0 fetch, receive-pack v0 with report-status) from its own object store, the REST v3 API (repositories, contents, refs, issues, labels, pull requests with squash merge), GraphQL v4 with introspection, and an MCP endpoint whose six tools act on the same store. All state is deterministic — counter ids and tick timestamps, never the wall clock — so a trial and its replay leave byte-identical exports. On the kit's sealed practice suite it passes all 120 conformance checks (git 30, repos 15, issues 15, pulls 20, protocol 5, GraphQL 20, MCP 15), and real git CLI clone/push/deepen/unshallow interop is verified end to end.

## Run it

```sh
node main.ts   # binds an ephemeral port, registers it with $MAKEFUN_ENV_URL, serves until /done
```

{description}

## Run it

```sh
{run}
```

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
