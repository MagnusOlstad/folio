/** Minimal HTMLAudioElement stand-in: tracks position/paused state and lets tests fire media events. */
export class FakeAudio extends EventTarget {
  static last: FakeAudio | null = null;
  preload = "";
  duration = 120;
  currentTime = 0;
  paused = true;
  ended = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  playCalls = 0;
  private attributes = new Map<string, string>();

  constructor() {
    super();
    FakeAudio.last = this;
  }

  set src(value: string) { this.attributes.set("src", value); }
  get src() { return this.attributes.get("src") ?? ""; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  play() { this.playCalls += 1; this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } }
  tick(time: number) { this.currentTime = time; this.dispatchEvent(new Event("timeupdate")); }
}
