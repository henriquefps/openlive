// SPDX-License-Identifier: AGPL-3.0-only

// The phone side of a voice call (Android): the foreground service and its notification, the audio
// mode and device, the route (speaker, earpiece, headset) and the permissions. It carries no voice
// logic: signalling, tracks and the SFU session belong to the voice client (A3); this is what that
// client calls to keep a call alive on a phone. The native side (modules/openlive-audio) is
// injected, so the state machine is tested without a device.

export type RoutePreference = 'auto' | 'speaker' | 'earpiece';
/** Where the sound really goes. */
export type ActiveRoute = 'speaker' | 'earpiece' | 'wired' | 'bluetooth';
export type NotificationAction = 'mute' | 'unmute' | 'leave';
export type PermissionResult = 'granted' | 'denied' | 'blocked';
export type SessionState = 'idle' | 'starting' | 'active';
export type EndReason = 'stopped' | 'leave_action' | 'task_removed' | 'service_stopped';

export interface RouteInfo {
  active: ActiveRoute;
  available: ActiveRoute[];
}

/** The texts of the notification, in the app's language (the native side has no translations). */
export interface NotificationTexts {
  /** "In voice in #room". */
  title: string;
  /** The server's name and address. */
  text: string;
  mute: string;
  unmute: string;
  leave: string;
  /** The notification channel's name in the system settings. */
  channel: string;
}

export interface ServiceOptions extends NotificationTexts {
  muted: boolean;
  /** False for a listen-only call: the service then does not claim the microphone. */
  microphone: boolean;
}

/** What the native device report says about the voice audio device. */
export interface VoiceDevice {
  hardwareAec: boolean;
  hardwareNs: boolean;
  /** False when WebRTC's module was not found: voice then keeps the media playout. */
  swapped: boolean;
}

export type NativeEvent =
  | { type: 'action'; action: NotificationAction }
  | { type: 'ended'; reason: 'task_removed' | 'service_stopped' }
  | { type: 'route'; route: RouteInfo }
  | { type: 'level'; level: number };

export interface NativeVoice {
  /** Starts the foreground service (rejects when the system does not allow it). */
  startService(options: ServiceOptions): Promise<void>;
  updateService(options: ServiceOptions): void;
  stopService(): void;
  /** Switches the WebRTC audio device to the voice one (call playout, hardware AEC / NS). */
  useVoiceDevice(): VoiceDevice;
  /** Back to the media playout of watching. */
  useMediaDevice(): void;
  setRoute(route: RoutePreference): void;
  clearRoute(): void;
  getRoute(): RouteInfo;
  startMicMonitor(): void;
  stopMicMonitor(): void;
  onEvent(listener: (event: NativeEvent) => void): () => void;
}

export interface PermissionsApi {
  isMicGranted(): Promise<boolean>;
  requestMic(): Promise<PermissionResult>;
  requestNotifications(): Promise<PermissionResult>;
  /** Android 12+: needed to route the call to a Bluetooth headset. */
  requestBluetooth(): Promise<PermissionResult>;
  /** Tells the person why the microphone is needed; true to go on to the system's question. */
  explainMic(): Promise<boolean>;
  openSettings(): void;
}

export interface AudioApi {
  enterVoice(): void;
  leaveVoice(): void;
}

export type VoiceErrorCode =
  'unsupported' | 'already_active' | 'mic_permission' | 'service_failed' | 'cancelled';

export class VoiceSessionError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VoiceSessionError';
  }
}

export interface StartOptions {
  /** The room's name, without the "#". */
  roomName: string;
  /** The server's name (an instance), shown with its address. */
  serverName: string;
  /** The server's address (its host), shown in the notification. */
  serverAddress?: string;
  /** The notification's texts; the defaults are English. */
  texts?: Partial<NotificationTexts>;
  /** Joins muted (the notification then offers "Unmute"). */
  muted?: boolean;
  /** False for a listen-only call. */
  microphone?: boolean;
  route?: RoutePreference;
}

export interface StartResult {
  device: VoiceDevice;
  /** False when notifications are off for the app (the call still runs; the shade shows nothing). */
  notifications: boolean;
}

export interface Snapshot {
  state: SessionState;
  muted: boolean;
  route: RoutePreference;
  active: ActiveRoute;
  available: ActiveRoute[];
  roomName: string | null;
  serverName: string | null;
  device: VoiceDevice | null;
}

const DEFAULT_TEXTS: NotificationTexts = {
  title: '',
  text: '',
  mute: 'Mute',
  unmute: 'Unmute',
  leave: 'Leave',
  channel: 'Voice call',
};

/** How long a notification's "Leave" waits for the app to leave by itself before it is forced. */
export const LEAVE_GRACE_MS = 3000;

export class VoiceSessionController {
  private state: SessionState = 'idle';
  private muted = false;
  private route: RoutePreference = 'auto';
  private routeInfo: RouteInfo = { active: 'speaker', available: ['speaker'] };
  private info: { roomName: string; serverName: string } | null = null;
  private device: VoiceDevice | null = null;
  private texts: NotificationTexts = DEFAULT_TEXTS;
  private microphone = true;
  // Bumped by every start and stop: a start that was overtaken by a stop knows it.
  private generation = 0;
  private snapshot: Snapshot | null = null;
  private off: (() => void) | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changes = new Set<() => void>();
  private readonly actions = new Set<(action: NotificationAction) => void>();
  private readonly endings = new Set<(reason: EndReason) => void>();

  constructor(
    private readonly native: NativeVoice | null,
    private readonly permissions: PermissionsApi,
    private readonly audio: AudioApi,
  ) {}

  /** Whether this build can keep a call alive (Android with the native module). */
  get supported(): boolean {
    return this.native !== null;
  }

  // -- state for React (useSyncExternalStore) -------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        state: this.state,
        muted: this.muted,
        route: this.route,
        active: this.routeInfo.active,
        available: this.routeInfo.available,
        roomName: this.info?.roomName ?? null,
        serverName: this.info?.serverName ?? null,
        device: this.device,
      };
    }
    return this.snapshot;
  };

  // -- permissions ----------------------------------------------------------------------------

  /**
   * The microphone permission with the reason first: when it is not granted yet, `explain` (or the
   * default dialog) tells why, and the system's question follows. `blocked` means the system will
   * not ask again: `openSettings()` is then the only way.
   */
  async requestMicPermission(
    explain: () => Promise<boolean> = () => this.permissions.explainMic(),
  ): Promise<PermissionResult> {
    if (await this.permissions.isMicGranted()) return 'granted';
    if (!(await explain())) return 'denied';
    return this.permissions.requestMic();
  }

  /** Android 13+: notifications are a permission. Without it the call runs, the shade shows nothing. */
  requestNotificationPermission = (): Promise<PermissionResult> =>
    this.permissions.requestNotifications();

  openSettings = (): void => this.permissions.openSettings();

  // -- the session ----------------------------------------------------------------------------

  /**
   * Keeps the call alive on the phone: audio mode and device, route, foreground service and
   * notification. Call it when the voice client has joined (or is joining) a room, after the
   * microphone permission was asked for: without it this rejects with `mic_permission` (unless
   * `microphone: false`).
   */
  async startVoiceSession(options: StartOptions): Promise<StartResult> {
    const native = this.native;
    if (!native) throw new VoiceSessionError('unsupported');
    if (this.state !== 'idle') throw new VoiceSessionError('already_active');
    this.state = 'starting';
    const generation = ++this.generation;
    this.microphone = options.microphone !== false;
    this.muted = options.muted === true;
    this.route = options.route ?? 'auto';
    this.info = { roomName: options.roomName, serverName: options.serverName };
    this.device = null;
    this.texts = this.textsFor(options);
    this.changed();
    try {
      if (this.microphone && !(await this.permissions.isMicGranted())) {
        throw new VoiceSessionError('mic_permission');
      }
      // The notification permission is asked for, not required.
      const notifications = (await this.permissions.requestNotifications()) === 'granted';
      await this.permissions.requestBluetooth();
      this.overtaken(generation);

      this.off = native.onEvent((event) => this.onNative(event));
      this.audio.enterVoice();
      this.device = native.useVoiceDevice();
      try {
        await native.startService(this.serviceOptions());
      } catch (error) {
        throw new VoiceSessionError('service_failed', String(error));
      }
      this.overtaken(generation);
      native.setRoute(this.route);
      this.routeInfo = native.getRoute();
      this.state = 'active';
      this.changed();
      return { device: this.device, notifications };
    } catch (error) {
      if (generation === this.generation) this.teardown();
      // A stop that came while the service was starting: make sure it does not stay up.
      else
        try {
          native.stopService();
        } catch {
          // Nothing to stop.
        }
      throw error;
    }
  }

  /** Ends the call on the phone (idempotent): service, notification, route, audio back to media. */
  stopVoiceSession(): void {
    if (this.state === 'idle') return;
    this.finish('stopped');
  }

  /** Mutes or unmutes in the notification (the voice client mutes the track itself). */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (this.state === 'active') this.native?.updateService(this.serviceOptions());
    this.changed();
  }

  /** Speaker, earpiece, or automatic (a wired or Bluetooth headset when there is one, else the speaker). */
  setRoute(route: RoutePreference): void {
    this.route = route;
    if (this.state === 'active' && this.native) {
      this.native.setRoute(route);
      this.routeInfo = this.native.getRoute();
    }
    this.changed();
  }

  /** The notification's "Mute", "Unmute" and "Leave" buttons. Returns how to stop listening. */
  onNotificationAction = (listener: (action: NotificationAction) => void): (() => void) => {
    this.actions.add(listener);
    return () => this.actions.delete(listener);
  };

  /** The call ended without the voice client asking: the app was closed, or the system stopped the service. */
  onSessionEnded = (listener: (reason: EndReason) => void): (() => void) => {
    this.endings.add(listener);
    return () => this.endings.delete(listener);
  };

  /** The microphone level, 0 to 1, about ten times a second (the debug screen's meter). */
  startMicMeter(listener: (level: number) => void): () => void {
    const native = this.native;
    if (!native) return () => undefined;
    const off = native.onEvent((event) => {
      if (event.type === 'level') listener(event.level);
    });
    native.startMicMonitor();
    return () => {
      off();
      native.stopMicMonitor();
    };
  }

  // -- internals ------------------------------------------------------------------------------

  private onNative(event: NativeEvent): void {
    if (event.type === 'route') {
      this.routeInfo = event.route;
      this.changed();
    } else if (event.type === 'ended') {
      if (this.state !== 'idle') this.finish(event.reason);
    } else if (event.type === 'action' && this.state !== 'idle') {
      this.onAction(event.action);
    }
  }

  private onAction(action: NotificationAction): void {
    if (action === 'leave') {
      // The voice client leaves its room and calls stopVoiceSession. With nobody listening, or a
      // client that does not, the session is stopped here so the notification does not linger.
      for (const listener of [...this.actions]) listener(action);
      if (this.actions.size === 0) this.finish('leave_action');
      else {
        this.leaveTimer ??= setTimeout(() => {
          this.leaveTimer = null;
          if (this.state !== 'idle') this.finish('leave_action');
        }, LEAVE_GRACE_MS);
      }
      return;
    }
    this.setMuted(action === 'mute');
    for (const listener of [...this.actions]) listener(action);
  }

  private finish(reason: EndReason): void {
    this.generation++;
    this.teardown();
    for (const listener of [...this.endings]) listener(reason);
  }

  private teardown(): void {
    const wasIdle = this.state === 'idle';
    this.state = 'idle';
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.off?.();
    this.off = null;
    this.muted = false;
    this.info = null;
    this.device = null;
    if (!wasIdle) {
      const native = this.native;
      // Each step on its own: a failure in one must not leave the service or the audio behind.
      for (const step of [
        () => native?.stopService(),
        () => native?.clearRoute(),
        () => native?.useMediaDevice(),
        () => this.audio.leaveVoice(),
      ]) {
        try {
          step();
        } catch {
          // Already gone (the service died first, the module was reloaded).
        }
      }
    }
    this.changed();
  }

  private overtaken(generation: number): void {
    if (generation !== this.generation) throw new VoiceSessionError('cancelled');
  }

  private textsFor(options: StartOptions): NotificationTexts {
    const given = options.texts ?? {};
    const address = options.serverAddress;
    // Texts the caller gives are used as they are; only the English defaults have placeholders.
    return {
      ...DEFAULT_TEXTS,
      ...given,
      title: given.title ?? `In voice in #${options.roomName}`,
      text: given.text ?? (address ? `${options.serverName} · ${address}` : options.serverName),
    };
  }

  private serviceOptions(): ServiceOptions {
    return { ...this.texts, muted: this.muted, microphone: this.microphone };
  }

  private changed(): void {
    this.snapshot = null;
    for (const listener of [...this.changes]) listener();
  }
}
