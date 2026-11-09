// Fork P2-SHARP: the ONE lazy sharp loader (transformersLocal pattern).
// Every guardrail needing sharp uses this; no private copies. A string-split
// specifier keeps bundlers from statically tracing it; cached after first load.
let _sharp: typeof import("sharp") | null = null;
export async function loadSharp(): Promise<typeof import("sharp")> {
  if (!_sharp) {
    const specifier = "sh" + "arp";
    _sharp = (await import(/* webpackIgnore: true */ specifier)) as typeof import("sharp");
  }
  return _sharp;
}
