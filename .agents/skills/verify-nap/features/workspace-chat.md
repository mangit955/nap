# Workspace chat and steering

The chat is the left half of a workspace. The user sends a follow-up and watches the turn live:
a working status, streamed reasoning, each step's prose and file changes, and the final answer.
While a turn runs, the composer becomes a steer box. What the user sends there is read at the
agent's next step and shown as "Sent while the agent worked".

## Sub-features

- `chat-follow-up`: Send starts a turn, and the transcript shows `You: <text>` and a working status.
- `chat-live`: while it runs, the status `Agent is working`, reasoning buttons, step prose and a
  `Changed 1 file` row appear; the composer offers `Stop` in place of `Send`.
- `chat-steer`: during a turn, typed text offers `Send to the running turn`; the steer goes from
  `Waiting for the agent's next step` to `Read at this step`, and the answer quotes it.
- `chat-stop`: Stop ends the running turn.
- `chat-done`: when a turn ends, `Worked for <n>s`, the answer with `Copy response`, a `Changed files`
  card, and the composer back to `Ask a follow-up…`.

## How to get to it (user POV)

- Open any session from the sidebar, or start one from the dashboard composer.
- Type in the textbox `Message` (in the group `Message composer`).
- To steer: type in the same textbox while a turn is running, then choose
  `Send to the running turn` or press Enter.

## Driving it with verify-nap

Preconditions:

- Baseline state. Open a session that is not running, such as **Seeded notes app**:
  `click --role link --name "Seeded notes app" --loose`.

- **Follow-up.** Run `fill --role textbox --name "Message" --value "Add a search box"`, then
  `click --role button --name "Send"`. The transcript gains `You: Add a search box` and the status
  `Agent is working`, and the composer's button is `Stop`.
- **Steer: type.** Within about 5 s of sending, run
  `fill --role textbox --name "Message" --value "Make the search box case-insensitive"`, then
  `shot --label "chat: steer typed"`. The placeholder reads `Steer the agent — it reads this at its
  next step…`, and a button `Send to the running turn` appears beside `Stop`.
- **Steer: send.** Run `click --role button --name "Send to the running turn"` (or `press --key Enter`),
  then `shot --label "chat: steer waiting"`. A group `Sent while the agent worked` holds
  `You: Make the search box case-insensitive` and `Waiting for the agent's next step`.
- **Steer: read.** Run `wait --text "Read at this step" --timeout 20000`, then
  `wait --role button --name "Stop" --state hidden --timeout 30000` and `shot --label "chat: steer read"`.
  The answer reads `Done. The newest message I read was: "Make the search box case-insensitive"`, and
  the composer placeholder is back to `Ask a follow-up…`.
- **Stop.** Send another follow-up (`fill … --value "Add tags"`, `click --role button --name "Send"`),
  then run `click --role button --name "Stop"` straight away, and
  `wait --role button --name "Stop" --state hidden --timeout 15000`. After `You: Add tags`, the
  transcript reads `You stopped this turn.` and `The turn was cancelled.`, and the composer returns
  to `Ask a follow-up…`.

## Gotchas

- A turn on the fakes lasts about 7.5 s. Each step waits 2.5 s, and a steer sent in the last step
  arrives after the agent's final call and is queued as the next turn rather than read. Steer
  within about 5 s of Send.
- The way to tell a steer that was read from one that was queued: the answer quotes the steer only
  when the model saw it.
- `Send` is absent, not disabled, while a turn runs. Don't wait on `Send` to detect the end of a
  turn; wait for `Stop` to be hidden.
