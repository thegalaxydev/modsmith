export interface WindowInfo {
  hwnd: number;
  pid: number;
  className: string;
  title: string;
  visible: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_VISIBLE = 0x10000000;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;
const WM_CLOSE = 0x0010;
const SW_SHOW = 5;
const SW_RESTORE = 9;
const SW_HIDE = 0;

type Fn = (...args: unknown[]) => unknown;

interface User32 {
  EnumWindows: Fn;
  GetWindowThreadProcessId: Fn;
  GetClassNameW: Fn;
  GetWindowTextW: Fn;
  IsWindowVisible: Fn;
  IsWindow: Fn;
  PostMessageW: Fn;
  SetParent: Fn;
  GetParent: Fn;
  GetWindowLongPtrW: Fn;
  SetWindowLongPtrW: Fn;
  SetWindowPos: Fn;
  ShowWindow: Fn;
  SetForegroundWindow: Fn;
  SetFocus: Fn;
  GetDpiForWindow: Fn;
  AttachThreadInput: Fn;
  GetCurrentThreadId: Fn;
  IsIconic: Fn;
}

let api: { user32: User32; koffi: typeof import('koffi'); EnumProc: unknown } | null = null;

function load() {
  if (process.platform !== 'win32') throw new Error('Native window integration is only implemented on Windows');
  if (api) return api;
  const koffi = require('koffi') as typeof import('koffi');
  const u = koffi.load('user32.dll');
  const k = koffi.load('kernel32.dll');
  const EnumProc = koffi.proto('bool __stdcall MwbEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  const user32: User32 = {
    EnumWindows: u.func('bool __stdcall EnumWindows(MwbEnumWindowsProc *cb, intptr_t lParam)'),
    GetWindowThreadProcessId: u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)'),
    GetClassNameW: u.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
    GetWindowTextW: u.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
    IsWindowVisible: u.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
    IsWindow: u.func('bool __stdcall IsWindow(intptr_t hwnd)'),
    PostMessageW: u.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    SetParent: u.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)'),
    GetParent: u.func('intptr_t __stdcall GetParent(intptr_t hwnd)'),
    GetWindowLongPtrW: u.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
    SetWindowLongPtrW: u.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
    SetWindowPos: u.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    ShowWindow: u.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
    SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
    SetFocus: u.func('intptr_t __stdcall SetFocus(intptr_t hwnd)'),
    GetDpiForWindow: u.func('uint32_t __stdcall GetDpiForWindow(intptr_t hwnd)'),
    AttachThreadInput: u.func('bool __stdcall AttachThreadInput(uint32_t a, uint32_t b, bool attach)'),
    GetCurrentThreadId: k.func('uint32_t __stdcall GetCurrentThreadId()'),
    IsIconic: u.func('bool __stdcall IsIconic(intptr_t hwnd)')
  };
  api = { user32, koffi, EnumProc };
  return api;
}

function wstr(fn: Fn, hwnd: number): string {
  const buf = new Uint16Array(512);
  const n = fn(hwnd, buf, 512) as number;
  return String.fromCharCode(...buf.subarray(0, n));
}

export function isSupported(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    load();
    return true;
  } catch {
    return false;
  }
}

export function windowPid(hwnd: number): { pid: number; thread: number } {
  const { user32 } = load();
  const out = [0];
  const thread = user32.GetWindowThreadProcessId(hwnd, out) as number;
  return { pid: out[0], thread };
}

export function listWindows(pids?: number[]): WindowInfo[] {
  const { user32, koffi, EnumProc } = load();
  const found: WindowInfo[] = [];
  const cb = koffi.register((hwnd: number) => {
    const { pid } = windowPid(hwnd);
    if (!pids || pids.includes(pid)) {
      found.push({ hwnd: Number(hwnd), pid, className: wstr(user32.GetClassNameW, hwnd), title: wstr(user32.GetWindowTextW, hwnd), visible: !!user32.IsWindowVisible(hwnd) });
    }
    return true;
  }, koffi.pointer(EnumProc as never));
  try {
    user32.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

export function findGameWindow(pids: number[]): WindowInfo | null {
  const wins = listWindows(pids).filter((w) => w.className.startsWith('GLFW') && !w.className.includes('Helper'));
  return wins.find((w) => w.visible) ?? wins[0] ?? null;
}

export function bringToFront(hwnd: number): boolean {
  const { user32 } = load();
  if (user32.IsIconic(hwnd)) user32.ShowWindow(hwnd, SW_RESTORE);
  return !!user32.SetForegroundWindow(hwnd);
}

export function closeWindow(hwnd: number): boolean {
  const { user32 } = load();
  return !!user32.PostMessageW(hwnd, WM_CLOSE, 0, 0);
}

export function isWindow(hwnd: number): boolean {
  const { user32 } = load();
  return !!user32.IsWindow(hwnd);
}

export function dpiScale(hwnd: number): number {
  const { user32 } = load();
  const dpi = user32.GetDpiForWindow(hwnd) as number;
  return dpi ? dpi / 96 : 1;
}

export interface DockState {
  child: number;
  parent: number;
  originalStyle: number;
  originalExStyle: number;
}

export function dock(child: number, parent: number, rect: Rect): DockState {
  const { user32 } = load();
  const originalStyle = Number(user32.GetWindowLongPtrW(child, GWL_STYLE));
  const originalExStyle = Number(user32.GetWindowLongPtrW(child, GWL_EXSTYLE));
  let style = originalStyle & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
  style |= WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE;
  if (user32.IsIconic(child)) user32.ShowWindow(child, SW_RESTORE);
  user32.SetWindowLongPtrW(child, GWL_STYLE, style);
  user32.SetWindowLongPtrW(child, GWL_EXSTYLE, originalExStyle & ~WS_EX_APPWINDOW);
  user32.SetParent(child, parent);
  user32.SetWindowPos(child, HWND_TOP, Math.round(rect.x), Math.round(rect.y), Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE);
  return { child, parent, originalStyle, originalExStyle };
}

export function moveDocked(child: number, rect: Rect): void {
  const { user32 } = load();
  user32.SetWindowPos(child, HWND_TOP, Math.round(rect.x), Math.round(rect.y), Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

export function setVisible(child: number, visible: boolean): void {
  const { user32 } = load();
  user32.ShowWindow(child, visible ? SW_SHOW : SW_HIDE);
}

export function undock(state: DockState): void {
  const { user32 } = load();
  if (!user32.IsWindow(state.child)) return;
  user32.SetParent(state.child, 0);
  user32.SetWindowLongPtrW(state.child, GWL_STYLE, state.originalStyle);
  user32.SetWindowLongPtrW(state.child, GWL_EXSTYLE, state.originalExStyle);
  user32.SetWindowPos(state.child, HWND_TOP, 80, 80, 1280, 720, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  user32.SetForegroundWindow(state.child);
}

export function focusDocked(child: number, parent: number): void {
  const { user32 } = load();
  const ours = user32.GetCurrentThreadId() as number;
  const theirs = windowPid(child).thread;
  user32.SetForegroundWindow(parent);
  if (theirs && theirs !== ours) {
    user32.AttachThreadInput(ours, theirs, true);
    user32.SetFocus(child);
    user32.AttachThreadInput(ours, theirs, false);
  } else {
    user32.SetFocus(child);
  }
}
