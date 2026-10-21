# magpie-grok-bot

A Magpie plugin that makes the **Grok Bot desktop app** (xAI) available as an OpenAI-compatible chat provider. Magpie drives your installed app over its local debug interface (CDP): it types your message into the selected bot's chat, streams the reply back as it is written, and keeps one Grok Bot session per Magpie conversation.

It is built and tested for **macOS** (Grok Bot 0.72). Windows keeps working with the same driver.

- Provider id: `grok-bot`; display name: `Grok Bot (xAI desktop)`.
- Models: `app-bot` (the bot selected in the app) plus one model per bot in your sidebar, listed live once you are signed in.
- Every model declares `tool_call: false`: Grok Bot runs its own tools and answers in prose.

## Requirements

- macOS with **Grok Bot.app** in `/Applications` (or `~/Applications`). Any other location works with the `grokBot.appPath` option.
- A Grok Bot account, signed in in the Grok Bot app. Magpie uses that existing sign-in (see First run).
- Magpie with its plugin host (Bun). The smoke test runs on Node 22 or newer.

## Install

1. Install Grok Bot from xAI and drag **Grok Bot.app** into `/Applications`. Open it once so macOS clears its quarantine prompt, then quit it if you like.
2. Add the plugin in one of three ways:
   - **CLI:**
     ```sh
     magpie plugin add github:keizman/magpie-grok-bot
     ```
   - **Config file:** add the spec to `~/.config/magpie/plugins.json` and restart Magpie:
     ```json
     { "plugins": [ { "spec": "github:keizman/magpie-grok-bot" } ] }
     ```
     If the file already lists plugins, add `{ "spec": "github:keizman/magpie-grok-bot" }` to the existing `plugins` array.
   - **App:** open Magpie, go to **Plugins → Add a plugin**, and enter `github:keizman/magpie-grok-bot`.
3. Check that the provider loaded:
   ```sh
   magpie plugin list
   ```
   `grok-bot` should be listed as not signed in.

To work from a local checkout instead, run `magpie plugin add /absolute/path/to/magpie-grok-bot`.

## First run: sign in

```sh
magpie plugin login grok-bot
```

Choose **Drive the installed Grok Bot desktop app** (the first method). Magpie drives **your installed Grok Bot with its existing sign-in**; there is nothing extra to sign in to.

Magpie talks to the app through its debug interface (CDP), which the app only opens when it is started with `--remote-debugging-port`. So:

- If Grok Bot isn't running, Magpie starts it with the debug interface on.
- If Grok Bot is already running **without** it (you opened it from the Dock or Finder), Magpie quits it gracefully (like ⌘Q) and reopens it with the debug interface on. This happens once; it stays debug-enabled until you quit it. Set `grokBot.restartApp` to `false` to get an error instead, then quit Grok Bot yourself.
- If Grok Bot is already running with the debug interface, Magpie attaches to it.

Magpie never quits the app when it is done; Grok Bot stays open as your normal app.

1. Make sure you're signed in in Grok Bot. If not, sign in in its window and retry (a request returns 401 until you do).
2. Select (or create) the bot you want to talk to in the sidebar.
3. Chat with the `grok-bot/app-bot` model, or pick a specific bot's model.

To keep Magpie away from your everyday window, set `grokBot.profile` to `"managed"`. Magpie then opens its own Grok Bot window with a separate profile in `~/Library/Application Support/Magpie/grok-bot-managed-profile`, which you sign in to once, and closes it after one idle minute (`grokBot.keepAliveMinutes`).

## How it works

### Streaming

Replies stream **while Grok Bot is still writing**. The driver adds a page binding (`Runtime.addBinding`) and a MutationObserver to the app window. On every change it reads the reply's markdown source from the app's own message component, falling back to the rendered text. It then pushes the cumulative text to Magpie, which emits each new piece as an SSE `content` delta. When bindings are unavailable, the driver polls the page every 150 ms (`grokBot.streamPollMs`) instead. Status lines such as "Alpha is writing" arrive separately as `reasoning_content`.

The reply is complete when Grok Bot shows no typing, activity or streaming indicator and the text has been unchanged for `grokBot.settleMs` (1.5 s). When Magpie starts the app, it launches it with background throttling disabled, so a hidden or covered window still streams at full speed.

The original Windows-only version of this provider did **not** stream answer text. It sent only progress lines while the bot worked and delivered the whole reply after it finished.

### One Magpie conversation = one Grok Bot session

Each Grok Bot bot has one continuous chat, so a Magpie conversation becomes a **tagged segment** of the chosen bot's chat. Magpie sends the full history with every request. The plugin works out what Grok Bot has already seen and sends only the rest:

| Situation | What is sent to Grok Bot |
|---|---|
| First message of a conversation | A one-line header (`[New conversation <tag> from Magpie. Treat anything earlier in this chat as unrelated to it.]`), the system prompt (once), and the message |
| Next message in the same conversation | **Only the new user message** |
| The same request again (a retry) | Nothing; the plugin reattaches to the reply already in the chat |
| History Grok Bot has never seen (the conversation started elsewhere, or the history was edited or branched) | One catch-up prompt holding the whole conversation, then normal follow-ups from there on |

How the plugin keeps track:

- **Conversation key.** A conversation is identified by Magpie's session ID (passed through the `x-magpie-cloud-agents-session` header). Without a session ID, it falls back to the model and the first user message.
- **Marker.** Every prompt ends with a short marker, `[magpie <tag>.<turn>.<hash>]`. The hash covers the conversation's user messages up to that turn, which lets the plugin match the reply to its prompt and detect retries. Set `grokBot.marker` to `false` to leave it out: the plugin then finds your message by its text, after the chat position it was sent at (falling back to the newest user message there). Retries still reattach when the conversation store has the turn, but a conversation can no longer be recovered from the chat after its store entry is lost; it gets a one-time catch-up instead.
- **Store.** Delivered turns are recorded in `~/Library/Application Support/Magpie/grok-bot/conversations.json` (`grokBot.stateDir`). The file is private (mode 600) and written atomically. It holds only hashes, tags and bot ids, never message text. Entries expire after 30 days, and at most 500 are kept.
- **Restarts.** Because the store is on disk, a conversation continues correctly after Magpie restarts. If the store is lost, the plugin looks for the conversation's markers in the bot's chat and continues from the last one whose hash matches.
- **Bot pinning.** A conversation stays with the bot it started on, even if you select another bot in the app later. Picking a different bot's model starts a catch-up segment in that bot.
- **One reply at a time.** The app window shows one chat at a time, so a second request while a reply is streaming gets HTTP 409. Ask again once the first reply finishes.

### What appears in your Grok Bot account

Messages are typed into the app as you. They appear in the bot's chat and on your account like anything you type yourself, including the header line and the `[magpie …]` markers (unless you turn them off with `grokBot.sessionHeader` and `grokBot.marker`).

## Options

Set options with `magpie plugin options github:keizman/magpie-grok-bot '<json>'`. All Grok Bot settings live under `grokBot`. An invalid known value stops the plugin from loading, and the error names the option. Unknown keys are ignored.

| Option | Default | Effect |
|---|---|---|
| `progress` | `true` | Send status lines as `reasoning_content` |
| `maxRunMinutes` | `30` | Longest a single reply may take; after that, the request returns 504 and asking again reattaches |
| `maxPromptBytes` | `262144` | Size cap for catch-up prompts |
| `grokBot.appPath` | auto | Path to `Grok Bot.app` (or to its executable) |
| `grokBot.profile` | `"app"` | `"app"` drives your installed Grok Bot with its existing sign-in; `"managed"` uses a separate Magpie window and profile |
| `grokBot.restartApp` | `true` | With `"app"`, quit and reopen a Grok Bot that is running without its debug interface; `false` returns an error instead |
| `grokBot.quitTimeoutMs` | `15000` | How long to wait for Grok Bot to quit before reopening it |
| `grokBot.profileDir` | `~/Library/Application Support/Magpie/grok-bot-managed-profile` | Profile for the `"managed"` window (setting it implies `"managed"`) |
| `grokBot.stateDir` | `~/Library/Application Support/Magpie/grok-bot` | Folder for the conversation store |
| `grokBot.persistSessions` | `true` | Set to `false` to keep the conversation store in memory only |
| `grokBot.systemPrompt` | `"first"` | `"first"` sends the system prompt once per conversation; `"never"` doesn't send it |
| `grokBot.sessionHeader` | `true` | Set to `false` to leave out the "New conversation" header line |
| `grokBot.marker` | `true` | Set to `false` to leave out the `[magpie …]` line at the end of each prompt (see Marker above) |
| `grokBot.keepAliveMinutes` | `1` | Idle minutes before Magpie disconnects (and, with `"managed"`, closes its window) |
| `grokBot.launchTimeoutMs` / `grokBot.appBootMs` | `10000` / `15000` | How long launch and page start may take |
| `grokBot.settleMs` | `1500` | Unchanged-text interval that ends a reply |
| `grokBot.stuckMs` | `120000` | Ends a reply when the text hasn't changed for this long, even if an activity indicator stays on |
| `grokBot.emptyMs` | `20000` | Ends a reply that produced no text after this long without activity |
| `grokBot.streamPollMs` | `150` | Polling interval when bindings are unavailable |
| `grokBot.reattachPorts` | `[]` | Debug ports of Grok Bot windows you started yourself with `--remote-debugging-port`; Magpie attaches to them instead of launching its own |
| `grokBot.bringToFront` | `false` | Bring the Grok Bot window to the front before typing |
| `grokBot.selectors` | built in | CSS selector overrides (`chat`, `row`, `userRow`, `assistant`, `prose`, `working`, `busyRow`, `failedRow`, `composer`, `botItem`, `selectedBot`, `signIn`) for when an app update moves its markup |

Set `MAGPIE_GROK_BOT_DEBUG=1` in Magpie's environment to log plugin startup events. The log holds provider ids and fixed event names only, never prompts or option values.

## Smoke test (real Mac)

This sends real messages to your bot.

```sh
git clone https://github.com/keizman/magpie-grok-bot.git
cd magpie-grok-bot
node scripts/smoke-test.mjs                 # every step, using the bot selected in the app
node scripts/smoke-test.mjs --bot <bot-id>  # a specific bot (ids are printed at start)
node scripts/smoke-test.mjs --skip-extra    # skip the catch-up step
node scripts/smoke-test.mjs --inspect       # print bridge names and a text-free markup skeleton
node scripts/smoke-test.mjs --managed       # use a separate Magpie profile instead of your signed-in app
```

The script loads `index.mjs` the way Magpie does. It attaches to your Grok Bot (quitting and reopening it with the debug interface if needed) and waits up to five minutes if you still need to sign in. Each streamed chunk is printed with a timestamp. The steps:

1. **Session A, turn 1:** "Please remember the number 4721…"
2. **Session A, turn 2:** "What number did I ask you to remember?" The full history is sent, as Magpie sends it. The step passes if the reply contains 4721 and the conversation store still shows a single segment.
3. **Simulated restart:** a fresh plugin instance continues session A ("Add one to that number"). The step passes if the reply contains 4722 and the stored segment was reused, which proves only the new message was sent.
4. **Session B:** a new conversation gets its own segment.
5. **Catch-up:** a conversation with invented earlier history ("My favourite colour is teal") is sent once as a folded prompt, and the reply must say teal.

It ends with a PASS/FAIL summary and exits non-zero if any step fails. Your Grok Bot stays open afterwards. With `--managed`, Magpie's window closes; add `--keep-open` to leave it running.

If a step fails after an app update, run `--inspect` and compare the output with the defaults in `providers/grok-bot-cdp.mjs` (`DEFAULT_SELECTORS`). You can fix most changes without a code change through `grokBot.selectors`.

## Development

```sh
bun scripts/test.mjs          # unit tests (mocked app; runs on macOS, Linux and Windows)
bun scripts/check.mjs         # plugin shape gate
bun scripts/check.mjs --stubs # the same, with every process/network entry point blocked
```

The unit tests replace the app with an in-memory fake and cover the following:

- macOS app detection (XML and binary `Info.plist`, `~/Applications`, `appPath`, and a missing app or executable)
- `ps` parsing and identity-checked shutdown
- launch arguments
- ordered streaming deltas, the polling fallback and non-streamed replies
- session mapping: new, continue, retry, edit or branch, unseen history, restart with the persisted store, marker recovery and bot pinning

`scripts/test.mjs` skips the Direct Connect tests on systems other than Windows, because Direct Connect loads a Windows-only system library.

`scripts/try.sh` (POSIX) and `scripts/try.ps1` (Windows) install the checkout into a throwaway Magpie home, for example `MAGPIE=/path/to/magpie sh scripts/try.sh --metadata-only`.

## Security notes

- A CDP debug port has no authentication. While it is open, any local program running as you can control the signed-in app. Magpie binds it to `127.0.0.1` only. With the default `"app"` profile, the port stays open until you quit Grok Bot; use `"managed"` if you want it limited to a separate profile that closes after the idle interval.
- With `"app"`, Magpie quits your Grok Bot only to reopen it with the debug interface, after re-checking its PID and start time, and never on shutdown. With `"managed"`, Magpie stops only processes it started, confirmed by PID, start time, executable and a random launch tag.
- No Grok Bot credential is read, copied or sent anywhere by the default method. The conversation store holds hashes only.

## Direct Connect (Windows only, unchanged)

The second sign-in method, **Direct Connect protocol**, is kept exactly as it was and works on Windows only. It reads the app's sealed sign-in from its Windows profile through DPAPI and speaks the app's undocumented backend protocol. **Account risk:** it uses the app's web-session credential against undocumented interfaces, which may violate the vendor's terms and could get the account suspended. Prefer the default app-drive method. Direct Connect does not stream answer text, and its follow-up handling is the original in-memory version. It is not supported on macOS.

## 中文快速说明

1. 把 **Grok Bot.app** 放进 `/Applications`。
2. 安装插件：`magpie plugin add github:keizman/magpie-grok-bot`。也可以在 `~/.config/magpie/plugins.json` 里加入 `{"plugins":[{"spec":"github:keizman/magpie-grok-bot"}]}`，或者在 Magpie 应用的 **Plugins → Add a plugin** 中添加。
3. 运行 `magpie plugin login grok-bot`，选择第一种方式。插件直接使用你已经登录的 Grok Bot。如果 Grok Bot 正在运行但没有开启调试接口，插件会正常退出它并带调试接口重新打开（只需一次；设 `grokBot.restartApp: false` 可禁止）。想用独立窗口和独立配置，设 `grokBot.profile: "managed"`。
4. 回复会在 Grok Bot 生成的同时流式返回。每个 Magpie 会话对应所选 Bot 聊天里的一个带标签的会话段，后续轮次只发送新的用户消息；重启后也能接着之前的会话继续。
5. 真机验证：`node scripts/smoke-test.mjs`。

## License

MIT
