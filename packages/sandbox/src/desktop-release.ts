/** Fixed X11 cleanup, including non-modifier keys interrupted inside key/type.
 * XSync precedes the state query. A failed release or query never issues a certificate.
 */
export const RELEASE_PRESSED_INPUT = String.raw`
import ctypes as c
x = c.CDLL("libX11.so.6")
t = c.CDLL("libXtst.so.6")
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XQueryKeymap.argtypes = [c.c_void_p, c.c_char_p]
x.XQueryKeymap.restype = c.c_int
x.XSync.argtypes = [c.c_void_p, c.c_int]
x.XDisplayKeycodes.argtypes = [c.c_void_p, c.POINTER(c.c_int), c.POINTER(c.c_int)]
x.XGetPointerMapping.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int]
x.XGetPointerMapping.restype = c.c_int
x.XQueryPointer.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint)]
x.XQueryPointer.restype = c.c_int
t.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
t.XTestFakeKeyEvent.restype = c.c_int
t.XTestFakeButtonEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
t.XTestFakeButtonEvent.restype = c.c_int
x.XCloseDisplay.argtypes = [c.c_void_p]
d = x.XOpenDisplay(None)
if not d: raise RuntimeError("No X11 display")
try:
    minimum, maximum = c.c_int(), c.c_int()
    x.XDisplayKeycodes(d, c.byref(minimum), c.byref(maximum))
    if not 8 <= minimum.value <= maximum.value <= 255: raise RuntimeError("Invalid keycode range")
    mapping = (c.c_ubyte * 256)()
    buttons = x.XGetPointerMapping(d, mapping, 256)
    if not 1 <= buttons <= 256: raise RuntimeError("Invalid button range")
    for key in range(minimum.value, maximum.value + 1):
        if not t.XTestFakeKeyEvent(d, key, 0, 0): raise RuntimeError("Key release failed")
    for button in range(1, buttons + 1):
        if not t.XTestFakeButtonEvent(d, button, 0, 0): raise RuntimeError("Button release failed")
    x.XSync(d, 0)
    keys = c.create_string_buffer(32)
    x.XQueryKeymap(d, keys)
    if any(keys.raw): raise RuntimeError("Keys remain pressed")
    root, child = c.c_ulong(), c.c_ulong()
    rx, ry, wx, wy, mask = c.c_int(), c.c_int(), c.c_int(), c.c_int(), c.c_uint()
    if not x.XQueryPointer(d, x.XDefaultRootWindow(d), c.byref(root), c.byref(child), c.byref(rx), c.byref(ry), c.byref(wx), c.byref(wy), c.byref(mask)): raise RuntimeError("Pointer query failed")
    if mask.value & 0x1f00: raise RuntimeError("Buttons remain pressed")
finally:
    x.XCloseDisplay(d)
`;
