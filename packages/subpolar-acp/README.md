# Managed ACP proxy

`subpolar-acp` keeps its existing local runtime as the default. Set
`SUBPOLAR_ACP_EXECUTION=managed` to proxy ACP sessions to a process started by
the authenticated Subpolar environment manager. The proxy keeps ACP on stdio,
starts a separate worker process for each `session/new` cwd, forwards session
requests and notifications through `effect-acp`, and forwards worker permission
requests to the T3 ACP client. The worker's ACP session ID is returned unchanged
to T3 and remains the ID used for subsequent calls and updates. Requests that
need a worker must carry that session ID; unscoped requests fail instead of
being sent to an arbitrary session's worktree.

Managed mode requires `SUBPOLAR_MANAGER_URL`, `SUBPOLAR_MANAGER_TOKEN`,
`SUBPOLAR_STORAGE_ROOT`, and `SUBPOLAR_ACP_WORKER_COMMAND`. The worker command
must be a JSON argv array, for example:

```sh
SUBPOLAR_ACP_EXECUTION=managed
SUBPOLAR_ACP_WORKER_COMMAND='["/opt/subpolar/bin/acp-worker"]'
```

Use HTTPS for a manager outside the local machine. Plain HTTP works for
loopback URLs by default. A private Docker Compose service URL requires
`SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP=true` on the T3 process; this accepts
private IPs and the shipped `subpolar-manager` Compose service name. Other DNS
names, including arbitrary single-label, `.internal`, and `.local` names, are
rejected. Limit the opt-in to trusted private networks because the manager
token is sent with each request.

The command is passed directly to the manager without a shell. It must name an
ACP server executable that is already installed in the worker image. Do not
point it at this gateway's ACP CLI unless that CLI and its dependencies are
also packaged in the worker image; the worker environment sets
`SUBPOLAR_ACP_EXECUTION=local` to prevent recursive manager proxying.

The worker image recipe installs the Subpolar ACP package and Pi SDK. It does
not copy Pi credentials into the worker image or worker filesystem. Managed Pi
credentials remain in T3's provider-instance store and are available to the
worker only through the active ACP session bridge.

When the worker command starts the Subpolar ACP CLI, the managed proxy supplies
`SUBPOLAR_ACP_WORKER_MODE=1` and `SUBPOLAR_ACP_EXECUTION=local` in the worker's
filtered environment. Worker mode adds one `execute` tool that runs argv
directly inside the worker, requires T3's existing per-call ACP approval,
limits captured output to 128 KiB, and confines its working directory to the
mounted worktree. The tool does not call the environment manager and rejects
attempts to pass manager credentials to child commands. Ordinary local ACP
mode keeps its existing manager-backed tool behavior.

Worker mode supplies local command execution. The managed worker image also
packages the ACP CLI and Pi SDK. Configure `Use T3 managed Pi
credentials` and a Pi provider ID on the ACP provider instance to keep Pi
credentials in T3's instance-scoped encrypted store. To enable model requests,
also turn on `Enable managed Pi model requests`. Model HTTP requests then pass
over the session-bound ACP bridge to the T3 host; the worker remains on Docker's
`none` network. Only fixed public API hosts for Anthropic, DeepSeek, Google
Generative Language, Groq, Mistral, OpenAI, OpenRouter, and xAI are enabled.
Custom endpoints, WebSocket transports, Google Vertex, model catalog refresh,
and deferred model operations fail closed. The bridge buffers each response up
to its size cap, so long streamed responses may be slower. A real integrated T3
thread turn still requires end-to-end validation.
