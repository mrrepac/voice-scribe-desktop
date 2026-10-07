# Windows helper

`build.ps1` compiles `bin/VoiceScribe.Native.exe` with the .NET Framework compiler
already provided by Windows. No SDK, NuGet packages, or administrator privileges
are needed. The process uses a Win32 message loop with a low-level keyboard hook;
there is no keyboard polling or regular-key logging. An output worker keeps pipe
writes out of the hook callback. Launch it from Electron with `windowsHide: true`
and piped stdin/stdout/stderr. Closing stdin removes the hook and exits.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1 -Test
```

`--diagnostics` verifies the SendInput ABI without installing the hook or changing
the desktop. `--self-test` runs shortcut routing tests with a fake clock and no
Windows input. `tests/native-smoke.ps1` additionally checks JSON IPC and safe
rejection of a nonexistent window; it does not send keys or change the clipboard.

## JSON lines protocol, version 1

All messages are UTF-8 JSON, one object per line. Requests use an `id` which is
echoed in responses. stdout contains protocol JSON only. Send `get-target` before
starting microphone capture from a nonactivating overlay. A normal settings
window takes focus, so recording via a global shortcut is the preferred workflow.

Events:

```json
{"event":"ready","protocol":1,"pid":1234}
{"event":"hotkey","action":"dictation-down","target":"123456"}
{"event":"hotkey","action":"dictation-up","heldMs":501}
{"event":"hotkey","action":"dictation-abort"}
{"event":"hotkey","action":"cancel","target":"123456"}
{"event":"hotkey","action":"proofread","target":"123456"}
{"event":"hotkey","action":"paste-last","target":"123456"}
```

- Ctrl+Space emits `dictation-down` with the foreground HWND. Releasing Space or
  Ctrl emits one `dictation-up`. Autorepeat is suppressed. The parent starts on
  down, leaves recording running for a release before 350 ms, and stops on a hold
  release at or after 350 ms. Pressing again while recording stops it.
- Escape emits `cancel` only while `active` is true and no modifiers are held.
- Ctrl+Shift+Space emits `proofread` in Scribe, or during an active session in another
  window. Outside Scribe while idle it passes through. The parent selects the review
  or plain mode using the event's foreground HWND. Bare Enter always passes through.
- `set-hotkey` with `hotkey` selects the dictation shortcut: `ctrl-space` (default),
  `ctrl-alt-space` or `win-alt` (left Win + left Alt). Proofreading is the same
  shortcut plus Shift; shortcuts of unselected presets pass through. Releasing any
  key of the shortcut ends a hold. The `win-alt` chord never swallows Win or Alt;
  when it fires, an unassigned key (0xE8) is injected so their release does not
  open Start or an application menu. A third non-Shift/Ctrl key pressed while the
  chord is held emits `dictation-abort` and passes through, so Win+Alt+<key>
  Windows shortcuts keep working.
- `set-scribe-window` with `target` registers the main Scribe HWND with the router.
- Ctrl+Alt+V emits `paste-last` with the current foreground HWND.
- Injected keyboard events are ignored; only recognized shortcuts are emitted.

Commands and representative replies:

```json
{"id":1,"command":"get-target"}
{"id":1,"ok":true,"target":"123456"}
{"id":2,"command":"set-active","active":true}
{"id":2,"ok":true}
{"id":3,"command":"insert","target":"123456","enter":false}
{"id":3,"ok":true,"status":"inserted","entered":false}
{"id":4,"command":"insert","target":"123456","enter":true}
{"id":4,"ok":true,"status":"clipboard-only","entered":false,"reason":"target-changed"}
{"id":5,"command":"diagnostics"}
{"id":8,"command":"window-info","target":"123456"}
{"id":8,"ok":true,"process":"Telegram.exe"}
{"id":7,"command":"cancel-insert"}
{"id":7,"ok":true,"cancelled":false}
{"id":6,"command":"quit"}
```

`window-info` returns the executable name of a window's process for per-application
profiles (`process` is null when Windows does not reveal it), or `window-gone`.
`set-active` should be true during recording and processing and false after
completion/cancellation. The parent owns clipboard text and writes it **before**
`insert`. The helper never reads or writes the clipboard. HWNDs are decimal
strings to avoid JavaScript integer truncation. Invalid requests return
`{"id":...,"ok":false,"error":"..."}`.

Insertion never activates another window. It requires a valid original target
which is still foreground, and waits up to 1500 ms for all modifiers, V, and Enter
to be released. Checks happen on the message-loop timer only while an insertion
is pending. A foreground change or held modifiers yields `clipboard-only` with
`target-changed` or `modifiers-held`. SendInput rejection, including Windows UIPI
blocking insertion into an elevated process, yields `input-blocked`. Only one
insertion may be pending; a concurrent request returns `insert-busy`.

`cancel-insert` synchronously drops any pending insertion and acknowledges whether
one was pending. Its original `insert` request resolves with `reason: "cancelled"`
and `entered: false`. Escape while active does this immediately in the hook,
before notifying the parent. If paste already happened, cancellation only prevents
the subsequent Enter and the original response still has `status: "inserted"`.
The parent should send `cancel-insert` when a session is cancelled or becomes idle.

`inserted` means Windows accepted the Ctrl+V input sequence; it does not prove
the destination supports paste or accepted the text. With `enter: true`, Enter
is sent 150 ms later only if Ctrl+V was accepted, the same target remains
foreground, and no modifier is held. If focus changes after paste, the result is
`inserted`, `entered: false`, `reason: "target-changed"`. The helper cannot identify
a different field within the same top-level window. Text stays on the clipboard
for manual paste. The parent should time out helper requests after at least
2500 ms and terminate a stuck child process.
