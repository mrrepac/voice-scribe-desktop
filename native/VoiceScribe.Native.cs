using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace VoiceScribe.Native
{
    // Only recognized shortcuts leave this process. Ordinary keys are never logged.
    internal sealed class HotkeyRouter
    {
        internal const int Space = 0x20, Escape = 0x1b, V = 0x56, LeftWin = 0x5b, LeftAlt = 0xa4, Insert = 0x2d, Enter = 0x0d;
        private readonly Func<long> clock;
        private readonly Action<Dictionary<string, object>> emit;
        private readonly HashSet<int> suppressed = new HashSet<int>();
        private bool dictationPressed;
        private bool chordDown;
        private long pressedAt;
        private string hotkey = "ctrl-space";
        // A custom shortcut: a main key plus exactly these modifiers.
        private bool custom;
        private int mainKey;
        private bool needControl, needAlt, needShift, needWin;
        internal bool Active;
        // Set by capture-hotkey: the next physical non-modifier key press is reported and swallowed.
        internal bool Capturing;
        // Bare Enter during a dictation finishes it and presses Enter after insertion.
        internal bool EnterFinishes;
        // Physical state of a key other than the one being handled.
        internal Func<int, bool> KeyDown = delegate { return false; };
        // Injects a neutral key so a modifier-only chord does not open Start or an app menu.
        internal Action Mask = delegate { };

        private static bool IsModifier(int key)
        {
            return IsShiftOrControl(key) || key == 0x12 || key == 0xa4 || key == 0xa5 || key == LeftWin || key == 0x5c;
        }

        // "key:" + optional "ctrl+", "alt+", "shift+", "win+" in this order + a virtual-key code.
        private static bool ParseCustom(string value, out int key, out bool control, out bool alt, out bool shift, out bool win)
        {
            key = 0; control = alt = shift = win = false;
            if (value == null || !value.StartsWith("key:", StringComparison.Ordinal)) return false;
            string rest = value.Substring(4);
            if (rest.StartsWith("ctrl+", StringComparison.Ordinal)) { control = true; rest = rest.Substring(5); }
            if (rest.StartsWith("alt+", StringComparison.Ordinal)) { alt = true; rest = rest.Substring(4); }
            if (rest.StartsWith("shift+", StringComparison.Ordinal)) { shift = true; rest = rest.Substring(6); }
            if (rest.StartsWith("win+", StringComparison.Ordinal)) { win = true; rest = rest.Substring(4); }
            if (rest.Length == 0 || rest.Length > 3) return false;
            foreach (char c in rest) if (c < '0' || c > '9') return false;
            key = int.Parse(rest, CultureInfo.InvariantCulture);
            return key >= 0x07 && key <= 0xfe && key != 0xe8 && key != Escape && !IsModifier(key);
        }

        internal static bool IsHotkey(string value)
        {
            int key; bool control, alt, shift, win;
            return value == "ctrl-space" || value == "ctrl-alt-space" || value == "win-alt" || value == "insert"
                || ParseCustom(value, out key, out control, out alt, out shift, out win);
        }

        internal string Hotkey
        {
            get { return hotkey; }
            set
            {
                if (!IsHotkey(value)) throw new ArgumentException("unknown-hotkey");
                hotkey = value;
                custom = ParseCustom(value, out mainKey, out needControl, out needAlt, out needShift, out needWin);
                dictationPressed = false;
                chordDown = false;
            }
        }

        private static bool IsShiftOrControl(int key)
        {
            return key == 0x10 || key == 0xa0 || key == 0xa1 || key == 0x11 || key == 0xa2 || key == 0xa3;
        }

        private bool ReleasesDictation(int key)
        {
            if (custom)
            {
                if (key == mainKey) return true;
                if (needControl && (key == 0x11 || key == 0xa2 || key == 0xa3)) return true;
                if (needAlt && (key == 0x12 || key == 0xa4 || key == 0xa5)) return true;
                if (needShift && (key == 0x10 || key == 0xa0 || key == 0xa1)) return true;
                return needWin && (key == LeftWin || key == 0x5c);
            }
            if (hotkey == "insert") return key == Insert;
            if (key == Space || key == 0x11 || key == 0xa2 || key == 0xa3) return true;
            return hotkey == "ctrl-alt-space" && (key == 0x12 || key == 0xa4 || key == 0xa5);
        }

        private void EmitDictationUp()
        {
            dictationPressed = false;
            emit(new Dictionary<string, object> {
                { "event", "hotkey" }, { "action", "dictation-up" },
                { "heldMs", Math.Max(0, clock() - pressedAt) }
            });
        }

        // Left Win + left Alt. Modifiers are never swallowed, so Windows always sees their release.
        private bool HandleChord(int key, bool down, bool control, bool shift, string target)
        {
            int other = key == LeftWin ? LeftAlt : LeftWin;
            if (!down)
            {
                bool wasDown = chordDown;
                chordDown = false;
                if (wasDown && dictationPressed) EmitDictationUp();
                return false;
            }
            if (!KeyDown(other)) { chordDown = false; return false; }
            if (chordDown || control) return false;
            chordDown = true;
            Mask();
            string action = null;
            if (!shift)
            {
                action = "dictation-down";
                dictationPressed = true;
                pressedAt = clock();
            }
            else if (Active) action = "finish";
            if (action != null) emit(new Dictionary<string, object> {
                { "event", "hotkey" }, { "action", action }, { "target", target }
            });
            return false;
        }

        internal HotkeyRouter(Func<long> clock, Action<Dictionary<string, object>> emit)
        {
            this.clock = clock;
            this.emit = emit;
        }

        // `ignored` is input this helper injected itself (or from a low-integrity process).
        // Keys emulated by other programs, such as a mouse button bound to Enter in
        // Logitech software or an AutoHotkey remap, are handled like physical ones.
        internal bool Handle(int key, bool down, bool control, bool shift, bool alt, bool win, bool ignored, string target)
        {
            if (ignored) return false;
            if (Capturing && down && !IsModifier(key))
            {
                Capturing = false;
                suppressed.Add(key);
                emit(new Dictionary<string, object> {
                    { "event", "hotkey-captured" }, { "key", key },
                    { "ctrl", control }, { "alt", alt }, { "shift", shift }, { "win", win }
                });
                return true;
            }
            bool chord = hotkey == "win-alt";
            if (chord && (key == LeftWin || key == LeftAlt)) return HandleChord(key, down, control, shift, target);
            if (!down)
            {
                // Releasing any part of the shortcut ends push-to-talk. Never swallow modifiers.
                if (!chord && dictationPressed && ReleasesDictation(key)) EmitDictationUp();
                return suppressed.Remove(key);
            }
            if (suppressed.Contains(key)) return true; // Swallow auto-repeat.
            if (chord && chordDown && dictationPressed && !IsShiftOrControl(key))
            {
                // Win+Alt+<key> is a Windows shortcut: drop the recording this press started.
                dictationPressed = false;
                emit(new Dictionary<string, object> { { "event", "hotkey" }, { "action", "dictation-abort" } });
                return false;
            }

            string action = null;
            if (custom && key == mainKey && control == needControl && alt == needAlt && shift == needShift && win == needWin)
            {
                // A swallowed key leaves Alt or Win "unused": their release would open a menu or Start.
                if (needWin || (needAlt && !needControl)) Mask();
                action = "dictation-down";
                dictationPressed = true;
                pressedAt = clock();
            }
            // Bare Insert only: Shift+Insert and Ctrl+Insert stay paste and copy.
            else if (hotkey == "insert" && key == Insert && !control && !shift && !alt && !win)
            {
                action = "dictation-down";
                dictationPressed = true;
                pressedAt = clock();
            }
            else if (!chord && !custom && hotkey != "insert" && key == Space && control && alt == (hotkey == "ctrl-alt-space") && !win)
            {
                if (!shift)
                {
                    action = "dictation-down";
                    dictationPressed = true;
                    pressedAt = clock();
                }
                // The shortcut plus Shift finishes a running dictation; while idle it passes through.
                else if (Active) action = "finish";
            }
            else if (key == V && control && alt && !shift && !win) action = "paste-last";
            else if (key == Escape && Active && !control && !shift && !alt && !win) action = "cancel";
            else if (key == Enter && Active && EnterFinishes && !control && !shift && !alt && !win) action = "finish-enter";

            if (action == null) return false;
            suppressed.Add(key);
            emit(new Dictionary<string, object> {
                { "event", "hotkey" }, { "action", action }, { "target", target }
            });
            return true;
        }
    }

    internal static class Program
    {
        private const int WH_KEYBOARD_LL = 13;
        private const uint WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
        private const uint WM_COMMAND_QUEUE = 0x8001, WM_TIMER = 0x113;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint LLKHF_LOWER_IL_INJECTED = 0x02, LLKHF_INJECTED = 0x10;
        // Marks this helper's own SendInput keys (Ctrl+V, Enter, the 0xE8 mask) so the hook skips them.
        private static readonly UIntPtr OwnInput = new UIntPtr(0x56534352); // "VSCR"
        private static readonly ConcurrentQueue<Dictionary<string, object>> commands = new ConcurrentQueue<Dictionary<string, object>>();
        private static readonly object outputLock = new object();
        private static readonly Stopwatch clock = Stopwatch.StartNew();
        private static readonly HookProc hookCallback = KeyboardHook;
        private static readonly HotkeyRouter router = new HotkeyRouter(delegate { return clock.ElapsedMilliseconds; }, EmitHotkey);
        private static uint mainThreadId;
        private static IntPtr hook;
        private static UIntPtr timer;
        private static volatile bool closing;
        private static PendingInsert pending;

        private sealed class PendingInsert
        {
            internal object Id;
            internal IntPtr Target;
            internal bool Enter;
            internal bool PasteSent;
            internal long Deadline;
            internal long EnterAfter;
        }

        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 1 && args[0] == "--diagnostics")
            {
                Emit(Diagnostics());
                return InputLayoutValid() ? 0 : 1;
            }
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            if (args.Length != 0)
            {
                Emit(new Dictionary<string, object> { { "event", "error" }, { "error", "unknown-argument" } });
                return 2;
            }
            if (!InputLayoutValid())
            {
                Emit(new Dictionary<string, object> { { "event", "error" }, { "error", "invalid-input-layout" } });
                return 1;
            }

            router.KeyDown = Down;
            router.Mask = MaskModifiers;
            mainThreadId = GetCurrentThreadId();
            MSG message;
            PeekMessage(out message, IntPtr.Zero, 0, 0, 0); // Create the main thread queue before stdin starts.
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, hookCallback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero)
            {
                Emit(new Dictionary<string, object> {
                    { "event", "error" }, { "error", "keyboard-hook-failed" }, { "win32", Marshal.GetLastWin32Error() }
                });
                return 1;
            }
            timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 20, IntPtr.Zero);
            if (timer == UIntPtr.Zero)
            {
                UnhookWindowsHookEx(hook);
                Emit(new Dictionary<string, object> { { "event", "error" }, { "error", "timer-failed" } });
                return 1;
            }

            // Output must not block the low-level keyboard hook: Windows removes slow hooks.
            outputThread = new Thread(WriteOutput);
            outputThread.IsBackground = true;
            outputThread.Start();
            Thread stdin = new Thread(ReadInput);
            stdin.IsBackground = true;
            stdin.Start();
            Emit(new Dictionary<string, object> {
                { "event", "ready" }, { "protocol", 1 }, { "pid", Process.GetCurrentProcess().Id }
            });
            int result = 0;
            try
            {
                int read;
                while ((read = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0)
                {
                    if (message.message == WM_COMMAND_QUEUE)
                    {
                        Dictionary<string, object> command;
                        while (commands.TryDequeue(out command)) ProcessCommand(command);
                    }
                    else if (message.message == WM_TIMER) AdvanceInsert();
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
                if (read < 0) result = 1;
            }
            finally
            {
                closing = true;
                KillTimer(IntPtr.Zero, timer);
                UnhookWindowsHookEx(hook);
                outputSignal.Set();
                outputThread.Join(500);
            }
            return result;
        }

        private static void ReadInput()
        {
            try
            {
                while (!closing)
                {
                    string line = Console.ReadLine();
                    if (line == null) break;
                    line = line.TrimStart('\ufeff'); // Some Windows pipe writers prepend a UTF-8 BOM.
                    if (line.Length > 16384)
                    {
                        Reply(null, false, "command-too-large");
                        continue;
                    }
                    try
                    {
                        JavaScriptSerializer json = new JavaScriptSerializer();
                        Dictionary<string, object> command = json.DeserializeObject(line) as Dictionary<string, object>;
                        if (command == null) throw new InvalidDataException();
                        commands.Enqueue(command);
                        PostThreadMessage(mainThreadId, WM_COMMAND_QUEUE, UIntPtr.Zero, IntPtr.Zero);
                    }
                    catch (Exception) { Reply(null, false, "invalid-json-command"); }
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            PostThreadMessage(mainThreadId, 0x12, UIntPtr.Zero, IntPtr.Zero); // WM_QUIT on parent exit.
        }

        private static void ProcessCommand(Dictionary<string, object> command)
        {
            object id;
            command.TryGetValue("id", out id);
            string action = Value(command, "command") as string;
            switch (action)
            {
                case "set-active":
                    if (!(Value(command, "active") is bool)) { Reply(id, false, "active-must-be-boolean"); return; }
                    router.Active = (bool)command["active"];
                    Reply(id, true, null);
                    break;
                case "set-enter-finish":
                    if (!(Value(command, "enabled") is bool)) { Reply(id, false, "enabled-must-be-boolean"); return; }
                    router.EnterFinishes = (bool)command["enabled"];
                    Reply(id, true, null);
                    break;
                case "set-hotkey":
                    string hotkey = Value(command, "hotkey") as string;
                    if (!HotkeyRouter.IsHotkey(hotkey)) { Reply(id, false, "unknown-hotkey"); return; }
                    router.Hotkey = hotkey;
                    Reply(id, true, null);
                    break;
                case "capture-hotkey":
                    router.Capturing = true;
                    Reply(id, true, null);
                    break;
                case "cancel-capture":
                    router.Capturing = false;
                    Reply(id, true, null);
                    break;
                case "get-target":
                    Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "target", WindowString(GetForegroundWindow()) } });
                    break;
                case "window-info":
                    WindowInfo(id, command);
                    break;
                case "diagnostics":
                    Dictionary<string, object> diagnostic = Diagnostics();
                    diagnostic.Remove("event");
                    diagnostic["id"] = id;
                    diagnostic["ok"] = true;
                    Emit(diagnostic);
                    break;
                case "insert":
                    BeginInsert(id, command);
                    break;
                case "cancel-insert":
                    bool cancelled = pending != null;
                    CancelPendingInsert();
                    Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "cancelled", cancelled } });
                    break;
                case "quit":
                    Reply(id, true, null);
                    PostQuitMessage(0);
                    break;
                default:
                    Reply(id, false, "unknown-command");
                    break;
            }
        }

        // HWNDs travel as decimal strings; reject anything that cannot be a handle on this platform.
        private static bool TryWindow(object value, out IntPtr window)
        {
            long number;
            window = IntPtr.Zero;
            if (!Int64.TryParse(value as string, NumberStyles.Integer, CultureInfo.InvariantCulture, out number)
                || number <= 0 || (IntPtr.Size == 4 && number > Int32.MaxValue)) return false;
            window = new IntPtr(number);
            return true;
        }

        // The executable of a window's process, for per-application dictation profiles. Reads nothing else.
        private static void WindowInfo(object id, Dictionary<string, object> command)
        {
            IntPtr window;
            if (!TryWindow(Value(command, "target"), out window)) { Reply(id, false, "invalid-target"); return; }
            uint processId;
            if (!IsWindow(window) || GetWindowThreadProcessId(window, out processId) == 0) { Reply(id, false, "window-gone"); return; }
            string process = null;
            try { using (Process owner = Process.GetProcessById((int)processId)) process = owner.ProcessName + ".exe"; }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            Emit(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "process", process } });
        }

        private static object Value(Dictionary<string, object> values, string name)
        {
            object value;
            return values.TryGetValue(name, out value) ? value : null;
        }

        private static void BeginInsert(object id, Dictionary<string, object> command)
        {
            if (pending != null) { Reply(id, false, "insert-busy"); return; }
            object enter = Value(command, "enter");
            if (enter != null && !(enter is bool)) { Reply(id, false, "enter-must-be-boolean"); return; }
            IntPtr target;
            if (!TryWindow(Value(command, "target"), out target)) { Reply(id, false, "invalid-target"); return; }
            pending = new PendingInsert {
                Id = id, Target = target, Enter = enter != null && (bool)enter,
                Deadline = clock.ElapsedMilliseconds + 1500
            };
            AdvanceInsert();
        }

        private static void AdvanceInsert()
        {
            if (pending == null) return;
            if (!IsWindow(pending.Target) || GetForegroundWindow() != pending.Target)
            {
                FinishInsert(pending.PasteSent ? "inserted" : "clipboard-only", "target-changed", false);
                return;
            }
            long now = clock.ElapsedMilliseconds;
            if (ModifiersDown())
            {
                if (now >= pending.Deadline)
                    FinishInsert(pending.PasteSent ? "inserted" : "clipboard-only", "modifiers-held", false);
                return;
            }
            if (!pending.PasteSent)
            {
                INPUT[] inputs = { KeyInput(0x11, false), KeyInput(0x56, false), KeyInput(0x56, true), KeyInput(0x11, true) };
                uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
                if (sent != inputs.Length)
                {
                    if (sent > 0) ReleaseInjectedKeys(false);
                    FinishInsert("clipboard-only", "input-blocked", false);
                    return;
                }
                pending.PasteSent = true;
                if (!pending.Enter) { FinishInsert("inserted", null, false); return; }
                pending.EnterAfter = now + 150;
                return;
            }
            if (now < pending.EnterAfter) return;
            INPUT[] enterInputs = { KeyInput(0x0d, false), KeyInput(0x0d, true) };
            uint enterSent = SendInput((uint)enterInputs.Length, enterInputs, Marshal.SizeOf(typeof(INPUT)));
            if (enterSent > 0 && enterSent != enterInputs.Length) ReleaseInjectedKeys(true);
            FinishInsert("inserted", enterSent == enterInputs.Length ? null : "enter-blocked", enterSent == enterInputs.Length);
        }

        private static void ReleaseInjectedKeys(bool enter)
        {
            INPUT[] releases = enter
                ? new INPUT[] { KeyInput(0x0d, true) }
                : new INPUT[] { KeyInput(0x56, true), KeyInput(0x11, true) };
            SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(INPUT)));
        }

        private static void FinishInsert(string status, string reason, bool entered)
        {
            PendingInsert operation = pending;
            pending = null;
            Emit(InsertResult(operation, status, reason, entered));
        }

        private static Dictionary<string, object> InsertResult(PendingInsert operation, string status, string reason, bool entered)
        {
            Dictionary<string, object> result = new Dictionary<string, object> {
                { "id", operation.Id }, { "ok", true }, { "status", status }, { "entered", entered }
            };
            if (reason != null) result["reason"] = reason;
            return result;
        }

        private static void CancelPendingInsert()
        {
            Dictionary<string, object> result = TakeCancelledInsert();
            if (result != null) Emit(result);
        }

        private static Dictionary<string, object> TakeCancelledInsert()
        {
            PendingInsert operation = pending;
            pending = null;
            if (operation == null) return null;
            return InsertResult(operation, operation.PasteSent ? "inserted" : "clipboard-only", "cancelled", false);
        }

        private static void EmitHotkey(Dictionary<string, object> value)
        {
            if (value.ContainsKey("action") && (string)value["action"] == "cancel")
            {
                // Cancel synchronously in the hook, before the parent receives Escape.
                Dictionary<string, object> result = TakeCancelledInsert();
                Emit(value);
                if (result != null) Emit(result);
                return;
            }
            Emit(value);
        }

        private static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

        private static void MaskModifiers()
        {
            // 0xE8 is unassigned. Like the AutoHotkey menu mask, it marks Win/Alt as used in a combination.
            INPUT[] mask = { KeyInput(0xe8, false), KeyInput(0xe8, true) };
            SendInput((uint)mask.Length, mask, Marshal.SizeOf(typeof(INPUT)));
        }
        private static bool ModifiersDown()
        {
            return Down(0x11) || Down(0x10) || Down(0x12) || Down(0x5b) || Down(0x5c)
                || Down(0x56) || Down(0x0d); // Also avoid interleaving physical V/Enter presses.
        }

        private static IntPtr KeyboardHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                uint message = unchecked((uint)wParam.ToInt64());
                bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
                if (down || up)
                {
                    KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    bool ignored = (data.flags & LLKHF_INJECTED) != 0
                        && (data.dwExtraInfo == OwnInput || (data.flags & LLKHF_LOWER_IL_INJECTED) != 0);
                    if (router.Handle((int)data.vkCode, down, Down(0x11), Down(0x10), Down(0x12), Down(0x5b) || Down(0x5c),
                        ignored, WindowString(GetForegroundWindow()))) return new IntPtr(1);
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }

        private static string WindowString(IntPtr window) { return window.ToInt64().ToString(CultureInfo.InvariantCulture); }

        private static INPUT KeyInput(ushort key, bool up)
        {
            return new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { wVk = key, dwFlags = up ? KEYEVENTF_KEYUP : 0, dwExtraInfo = OwnInput } } };
        }

        private static bool InputLayoutValid() { return Marshal.SizeOf(typeof(INPUT)) == (IntPtr.Size == 8 ? 40 : 28); }

        private static Dictionary<string, object> Diagnostics()
        {
            return new Dictionary<string, object> {
                { "event", "diagnostics" }, { "protocol", 1 }, { "pointerBytes", IntPtr.Size },
                { "inputSize", Marshal.SizeOf(typeof(INPUT)) }, { "expectedInputSize", IntPtr.Size == 8 ? 40 : 28 },
                { "inputUnionOffset", Marshal.OffsetOf(typeof(INPUT), "data").ToInt32() },
                { "inputLayoutValid", InputLayoutValid() }, { "keyboardHookInstalled", hook != IntPtr.Zero },
                { "framework", Environment.Version.ToString() }
            };
        }

        private static void Reply(object id, bool ok, string error)
        {
            Dictionary<string, object> result = new Dictionary<string, object> { { "id", id }, { "ok", ok } };
            if (error != null) result["error"] = error;
            Emit(result);
        }

        private static readonly ConcurrentQueue<Dictionary<string, object>> output = new ConcurrentQueue<Dictionary<string, object>>();
        private static readonly AutoResetEvent outputSignal = new AutoResetEvent(false);
        private static Thread outputThread;

        private static void Emit(Dictionary<string, object> value)
        {
            if (outputThread == null) { WriteLine(value); return; }
            output.Enqueue(value);
            outputSignal.Set();
        }

        private static void WriteOutput()
        {
            try
            {
                do
                {
                    Dictionary<string, object> value;
                    while (output.TryDequeue(out value)) WriteLine(value);
                    if (!closing) outputSignal.WaitOne(250);
                } while (!closing || !output.IsEmpty);
            }
            catch (IOException) { PostThreadMessage(mainThreadId, 0x12, UIntPtr.Zero, IntPtr.Zero); }
        }

        private static void WriteLine(Dictionary<string, object> value)
        {
            lock (outputLock)
            {
                Console.WriteLine(new JavaScriptSerializer().Serialize(value));
                Console.Out.Flush();
            }
        }

        private static int SelfTest()
        {
            List<Dictionary<string, object>> events = new List<Dictionary<string, object>>();
            long now = 100;
            HotkeyRouter test = new HotkeyRouter(delegate { return now; }, events.Add);
            int checks = 0;
            Action<bool, string> expect = delegate(bool condition, string message) {
                checks++;
                if (!condition) throw new Exception(message);
            };
            try
            {
                expect(InputLayoutValid(), "INPUT union must have native Win32 size");
                expect(!test.Handle(0x41, true, false, false, false, false, false, "1"), "ordinary keys pass through");
                expect(events.Count == 0, "ordinary keys emit nothing");
                expect(!test.Handle(0x1b, true, false, false, false, false, false, "1"), "inactive Escape passes through");
                expect(test.Handle(0x20, true, true, false, false, false, false, "123"), "Ctrl+Space is suppressed");
                expect((string)events[0]["action"] == "dictation-down" && (string)events[0]["target"] == "123", "start captures target");
                expect(test.Handle(0x20, true, true, false, false, false, false, "123") && events.Count == 1, "repeat suppressed without duplicate event");
                now += 100;
                expect(test.Handle(0x20, false, true, false, false, false, false, "123"), "Space keyup suppressed");
                expect((long)events[1]["heldMs"] == 100, "tap duration");
                now += 100;
                test.Handle(0x20, true, true, false, false, false, false, "123");
                now += 700;
                expect(!test.Handle(0xa2, false, false, false, false, false, false, "123"), "Ctrl keyup passes through");
                expect((long)events[3]["heldMs"] == 700, "releasing Ctrl ends hold");
                expect(test.Handle(0x20, false, false, false, false, false, false, "123") && events.Count == 4, "release emitted exactly once");
                expect(!test.Handle(0x20, true, true, false, false, false, true, "123"), "own injected keys ignored");
                test.Active = true;
                expect(test.Handle(0x20, true, true, true, false, false, false, "123"), "explicit finish shortcut");
                expect((string)events[4]["action"] == "finish", "finish event");
                test.Handle(0x20, false, true, true, false, false, false, "123");
                expect(!test.Handle(0x0d, true, false, false, false, false, false, "123"), "bare Enter always passes through");
                expect(test.Handle(0x1b, true, false, false, false, false, false, "123"), "active Escape suppressed");
                expect((string)events[5]["action"] == "cancel", "cancel event");
                test.Active = false;
                expect(test.Handle(0x1b, false, false, false, false, false, false, "123"), "Escape up stays suppressed after deactivation");
                expect(test.Handle(0x56, true, true, false, true, false, false, "321"), "paste last shortcut");
                expect((string)events[6]["action"] == "paste-last" && (string)events[6]["target"] == "321", "paste last target");
                expect(!test.Handle(0x41, false, false, false, false, false, false, "321"), "ordinary keyup passes through");
                pending = new PendingInsert { Id = 42, PasteSent = false, Enter = true };
                Dictionary<string, object> cancelled = TakeCancelledInsert();
                expect((string)cancelled["status"] == "clipboard-only" && (string)cancelled["reason"] == "cancelled", "cancel before paste leaves clipboard fallback");
                expect(pending == null && (bool)cancelled["entered"] == false, "cancellation drops pending input before returning");
                pending = new PendingInsert { Id = 43, PasteSent = true, Enter = true };
                cancelled = TakeCancelledInsert();
                expect((string)cancelled["status"] == "inserted" && (bool)cancelled["entered"] == false, "cancel after paste prevents Enter");
                expect(TakeCancelledInsert() == null, "cancelling idle insertion is harmless");
                int count = events.Count;
                expect(!test.Handle(0x20, true, true, true, false, false, false, "123") && events.Count == count, "idle finish shortcut passes through");
                test.Handle(0x20, false, true, true, false, false, false, "123");
                test.Active = true;
                expect(test.Handle(0x20, true, true, true, false, false, false, "999"), "active finish shortcut in another window");
                expect(events.Count == count + 1 && (string)events[count]["action"] == "finish", "finish emits once");
                expect(test.Handle(0x20, true, true, true, false, false, false, "999") && events.Count == count + 1, "finish repeat suppressed");
                test.Handle(0x20, false, true, true, false, false, false, "999");
                test.Active = false;
                HashSet<int> held = new HashSet<int>();
                int masks = 0;
                HotkeyRouter alt = new HotkeyRouter(delegate { return now; }, events.Add);
                alt.KeyDown = delegate(int key) { return held.Contains(key); };
                alt.Mask = delegate { masks++; };
                alt.Hotkey = "ctrl-alt-space";
                count = events.Count;
                expect(!alt.Handle(0x20, true, true, false, false, false, false, "5"), "plain Ctrl+Space passes through with another preset");
                expect(alt.Handle(0x20, true, true, false, true, false, false, "5") && (string)events[count]["action"] == "dictation-down", "Ctrl+Alt+Space starts");
                now += 500;
                expect(!alt.Handle(0xa4, false, true, false, false, false, false, "5") && (long)events[count + 1]["heldMs"] == 500, "releasing Alt ends hold");
                alt.Handle(0x20, false, true, false, false, false, false, "5");
                alt.Hotkey = "win-alt";
                count = events.Count;
                expect(!alt.Handle(0x5b, true, false, false, false, true, false, "5") && events.Count == count, "Win alone does nothing");
                held.Add(0x5b);
                expect(!alt.Handle(0xa4, true, false, false, true, true, false, "5"), "chord is never swallowed");
                expect((string)events[count]["action"] == "dictation-down" && masks == 1, "Win+Alt starts and masks Start menu");
                held.Add(0xa4);
                expect(!alt.Handle(0xa4, true, false, false, true, true, false, "5") && events.Count == count + 1 && masks == 1, "chord repeat ignored");
                now += 200;
                held.Remove(0xa4);
                expect(!alt.Handle(0xa4, false, false, false, false, true, false, "5") && (long)events[count + 1]["heldMs"] == 200, "releasing Alt ends chord");
                expect(!alt.Handle(0x5b, false, false, false, false, false, false, "5") && events.Count == count + 2, "second release emits nothing");
                held.Remove(0x5b);
                held.Add(0xa4);
                alt.Handle(0x5b, true, false, false, true, true, false, "5");
                held.Add(0x5b);
                expect(!alt.Handle(0x52, true, false, false, true, true, false, "5") && (string)events[count + 3]["action"] == "dictation-abort", "Win+Alt+R aborts and passes R through");
                alt.Handle(0x5b, false, false, false, true, false, false, "5");
                expect(events.Count == count + 4, "aborted chord emits no release");
                held.Remove(0x5b); held.Remove(0xa4);
                expect(!alt.Handle(0xa4, true, false, false, true, false, false, "5") && events.Count == count + 4, "stale Win state is ignored");
                expect(!alt.Handle(0x20, true, true, false, false, false, false, "5"), "Ctrl+Space is free with Win+Alt");
                HotkeyRouter ins = new HotkeyRouter(delegate { return now; }, events.Add);
                ins.Hotkey = "insert";
                count = events.Count;
                expect(!ins.Handle(0x20, true, true, false, false, false, false, "7") && events.Count == count, "Ctrl+Space is free with Insert");
                expect(!ins.Handle(0x2d, true, false, true, false, false, false, "7") && !ins.Handle(0x2d, true, true, false, false, false, false, "7") && events.Count == count, "Shift+Insert and Ctrl+Insert pass through");
                expect(ins.Handle(0x2d, true, false, false, false, false, false, "7") && (string)events[count]["action"] == "dictation-down", "Insert starts");
                now += 300;
                expect(ins.Handle(0x2d, false, false, false, false, false, false, "7") && (long)events[count + 1]["heldMs"] == 300, "releasing Insert ends hold");
                ins.Active = true;
                expect(!ins.Handle(0x0d, true, false, false, false, false, false, "7") && events.Count == count + 2, "Enter passes through unless enabled");
                ins.EnterFinishes = true;
                expect(ins.Handle(0x0d, true, false, false, false, false, false, "7") && (string)events[count + 2]["action"] == "finish-enter", "Enter finishes an active dictation");
                expect(ins.Handle(0x0d, false, false, false, false, false, false, "7"), "Enter keyup stays suppressed");
                expect(!ins.Handle(0x0d, true, false, true, false, false, false, "7"), "Shift+Enter passes through");
                ins.Active = false;
                expect(!ins.Handle(0x0d, true, false, false, false, false, false, "7") && events.Count == count + 3, "idle Enter passes through");
                expect(!HotkeyRouter.IsHotkey("key:27") && !HotkeyRouter.IsHotkey("key:162") && !HotkeyRouter.IsHotkey("key:alt+ctrl+120") && !HotkeyRouter.IsHotkey("key:1200"), "invalid custom shortcuts rejected");
                HotkeyRouter custom = new HotkeyRouter(delegate { return now; }, events.Add);
                custom.Mask = delegate { masks++; };
                custom.Hotkey = "key:120";
                count = events.Count;
                expect(!custom.Handle(0x20, true, true, false, false, false, false, "8"), "Ctrl+Space is free with a custom key");
                expect(!custom.Handle(0x78, true, true, false, false, false, false, "8") && !custom.Handle(0x78, true, false, true, false, false, false, "8") && events.Count == count, "F9 with extra modifiers passes through");
                expect(custom.Handle(0x78, true, false, false, false, false, false, "8") && (string)events[count]["action"] == "dictation-down", "bare F9 starts");
                expect(custom.Handle(0x78, true, false, false, false, false, false, "8") && events.Count == count + 1, "F9 repeat suppressed");
                now += 400;
                expect(custom.Handle(0x78, false, false, false, false, false, false, "8") && (long)events[count + 1]["heldMs"] == 400, "releasing F9 ends hold");
                custom.Active = true;
                custom.EnterFinishes = true;
                expect(custom.Handle(0x0d, true, false, false, false, false, false, "8") && (string)events[count + 2]["action"] == "finish-enter", "Enter finishes a dictation started with a custom key");
                custom.Handle(0x0d, false, false, false, false, false, false, "8");
                custom.Active = false;
                custom.Hotkey = "key:ctrl+shift+68";
                count = events.Count;
                expect(!custom.Handle(0x44, true, true, false, false, false, false, "8") && events.Count == count, "Ctrl+D passes through");
                expect(custom.Handle(0x44, true, true, true, false, false, false, "8") && (string)events[count]["action"] == "dictation-down", "Ctrl+Shift+D starts");
                expect(!custom.Handle(0xa0, false, true, false, false, false, false, "8") && events.Count == count + 2, "releasing Shift ends hold");
                custom.Handle(0x44, false, true, false, false, false, false, "8");
                custom.Hotkey = "key:win+75";
                count = events.Count;
                int before = masks;
                expect(custom.Handle(0x4b, true, false, false, false, true, false, "8") && (string)events[count]["action"] == "dictation-down" && masks == before + 1, "Win+K starts and masks Start menu");
                expect(!custom.Handle(0x5b, false, false, false, false, false, false, "8") && events.Count == count + 2, "releasing Win ends hold");
                expect(custom.Handle(0x4b, false, false, false, false, false, false, "8") && events.Count == count + 2, "key release swallowed without a second event");
                custom.Capturing = true;
                count = events.Count;
                expect(!custom.Handle(0xa2, true, true, false, false, false, false, "8") && events.Count == count, "capture waits for a main key");
                expect(custom.Handle(0x51, true, true, true, true, false, false, "8") && (string)events[count]["event"] == "hotkey-captured", "capture swallows and reports a key");
                expect((int)events[count]["key"] == 0x51 && (bool)events[count]["ctrl"] && (bool)events[count]["shift"] && (bool)events[count]["alt"] && !(bool)events[count]["win"], "capture reports modifiers");
                expect(!custom.Capturing && custom.Handle(0x51, false, true, true, true, false, false, "8"), "capture ends; release swallowed");
                expect(!custom.Handle(0x51, true, true, true, true, false, false, "8") && events.Count == count + 1, "keys pass through after capture");
                Emit(new Dictionary<string, object> { { "event", "self-test" }, { "ok", true }, { "checks", checks } });
                return 0;
            }
            catch (Exception error)
            {
                Emit(new Dictionary<string, object> { { "event", "self-test" }, { "ok", false }, { "checks", checks }, { "error", error.Message } });
                return 1;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public INPUTUNION data; }
        // MOUSEINPUT is required even when only sending keys: it determines the union's size.
        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mouse;
            [FieldOffset(0)] public KEYBDINPUT keyboard;
            [FieldOffset(0)] public HARDWAREINPUT hardware;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }
        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string moduleName);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG message, IntPtr window, uint min, uint max, uint remove);
        [DllImport("user32.dll")] private static extern int GetMessage(out MSG message, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG message);
        [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG message);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
        [DllImport("user32.dll")] private static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint interval, IntPtr callback);
        [DllImport("user32.dll")] private static extern bool KillTimer(IntPtr window, UIntPtr id);
    }
}
