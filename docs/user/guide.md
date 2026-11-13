# Using ERNIE Harness

[简体中文](guide.zh-CN.md) · [Website](https://luminousyyh.github.io/ernie-harness/en/#usage) · [README](../../README.md)

Use Node.js 24.9+ and pnpm 10.30.3. Install with `pnpm install --frozen-lockfile`, build with `pnpm build`, then run `pnpm cli setup` and `pnpm cli open`. On Linux substitute Linux project paths for the Windows examples below. Model access needs your own runtime credentials for `baidu/ernie-5.5-flash-preview:free`; the website itself requires none.

## A first task

```sh
pnpm cli workspace add "D:/projects/my-app" --name "my-app"
pnpm cli workspace list
pnpm cli workspace select <workspace-id>
pnpm cli run "Fix empty input and add a regression test" -w "D:/projects/my-app" -c "pnpm test" --supervised
pnpm cli list
pnpm cli show <goal-id>
```

Choose an acceptance command appropriate to that project. The sample command does not guarantee that every project uses pnpm. A supervised goal requires an acceptance command, and completion evidence must refer to its current revision and workspace. A model's statement that tests passed is not an independent test record.

Open the Web workspace with `pnpm cli open`, or the terminal UI with `pnpm cli tui -w "D:/projects/my-app"`. Add/select a workspace, start a chat, inspect each tool call and its result, then inspect acceptance records. Selection persists across service restarts; editing a workspace directory does not move old chats. The application defaults to Chinese; locale commands and English application text are under parallel integration in this version.

## Continue, pause, and recover

```sh
pnpm cli reply <goal-id> "Add error handling"
pnpm cli pause <goal-id>
pnpm cli resume <goal-id>
pnpm cli cancel <goal-id>
pnpm cli doctor
```

A reply retains history and cumulative budgets and advances the goal revision. Closing a page does not cancel a background goal. Exiting the service pauses work. Restart recovery checks unfinished tool records before issuing new work. If a write may have happened but its result was not recorded, inspect the workspace and journal and resolve the uncertain effect using the recovery UI. Do not rerun the write merely because the result is absent.

New memory, improvement, approval, session-branch, and checkpoint management commands are being integrated in `src/cli/commands.ts`. Inspect the current `pnpm cli --help` and the relevant tests before relying on them in automation. Checkpoint restoration changes workspace state and must follow the current approval/reconciliation policy.

## Budgets and model policy

The only permitted model is `baidu/ernie-5.5-flash-preview:free`, through the configured Baidu zero-price route. No alternate-model or paid fallback is allowed. Default cumulative caps are 20 requests, 2,000,000 input tokens, 128,000 output tokens including reasoning, 30 minutes of active time, and 16,384 output tokens per request. Reservations persist before dispatch. Retries, titles, reflections, and improvement calls are not free extra calls.

Quota exhaustion preserves state and stops new dispatch. Request estimates, configured effort, advertised capabilities, and live-verified capabilities are different facts. Treat a static screenshot or historic smoke run accordingly.

## Credentials and local execution

`setup` hides credential input. Windows uses current-user DPAPI; Linux uses a private credential file. Runtime `OPENROUTER_API_KEY` is another option. The service normally listens on `127.0.0.1:4317`. Its authenticated launch token is separate from the model credential; do not share that URL.

Local shell execution runs as your user. File boundary checks do not turn it into a general sandbox. Remote formal evaluation uses a separate Linux/Bubblewrap design. See [architecture](architecture.md), [extension trust](extensions.md), and [maturity gates](../maturity.md).

## Preview documentation offline

```sh
node scripts/site-build.mjs
pnpm site:preview
pnpm site:qa
```

The preview serves both `/ernie-harness/` and `/ernie-harness/en/`. Both are complete HTML, readable without JavaScript. Language links retain the current section when JavaScript is enabled. To check the browser locally, install Chromium with `pnpm exec playwright install chromium` or use `ERNIE_BROWSER`; installed Edge is supported on Windows. Site QA calls no model.
