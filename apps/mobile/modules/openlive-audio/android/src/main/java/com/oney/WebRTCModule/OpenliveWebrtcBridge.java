// SPDX-License-Identifier: AGPL-3.0-only
package com.oney.WebRTCModule;

import android.media.AudioAttributes;
import android.media.MediaRecorder;
import android.util.Log;
import com.facebook.react.bridge.ReactApplicationContext;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.audio.AudioDeviceModule;
import org.webrtc.audio.JavaAudioDeviceModule;

/**
 * Swaps the audio device react-native-webrtc's PeerConnectionFactory uses.
 *
 * The factory takes its audio device module when it is created, and the playout's AudioAttributes
 * are fixed in it (apps/mobile/plugins/with-openlive-audio.js builds the media one: USAGE_MEDIA, for
 * watching). Voice needs USAGE_VOICE_COMMUNICATION, hardware echo cancellation and noise
 * suppression, which no setter changes afterwards. So voice gets a second factory with its own
 * device, built once and kept; WebRTCModule.mFactory points at it while a voice session is on and at
 * the media one otherwise. A peer connection keeps the factory it was created with: a stream being
 * watched when voice starts goes on playing as media, and a voice connection (created after the
 * swap) plays as a call. Neither factory is ever disposed (a live peer connection would crash).
 *
 * This class lives in WebRTCModule's package to reach its package-private fields.
 */
public final class OpenliveWebrtcBridge {
    private static final String TAG = "OpenliveWebrtcBridge";

    private static WebRTCModule owner;
    private static PeerConnectionFactory mediaFactory;
    private static AudioDeviceModule mediaAdm;
    private static PeerConnectionFactory voiceFactory;
    private static AudioDeviceModule voiceAdm;

    private OpenliveWebrtcBridge() {}

    public static boolean hardwareAec() {
        return JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported();
    }

    public static boolean hardwareNs() {
        return JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported();
    }

    /** New peer connections and tracks use the voice device. Returns false if WebRTC is not loaded. */
    public static synchronized boolean useVoiceDevice(ReactApplicationContext context) {
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null) {
            Log.w(TAG, "WebRTCModule is not loaded; voice keeps the media audio device");
            return false;
        }
        if (owner != module) {
            // First use, or the JavaScript side was reloaded (a new module with a new factory).
            owner = module;
            mediaFactory = module.mFactory;
            mediaAdm = module.mAudioDeviceModule;
            voiceFactory = null;
            voiceAdm = null;
        }
        if (voiceFactory == null) {
            AudioDeviceModule adm =
                    JavaAudioDeviceModule.builder(context)
                            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                            .setAudioAttributes(
                                    new AudioAttributes.Builder()
                                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                            .build())
                            .setUseHardwareAcousticEchoCanceler(hardwareAec())
                            .setUseHardwareNoiseSuppressor(hardwareNs())
                            .setEnableVolumeLogger(false)
                            .createAudioDeviceModule();
            voiceFactory =
                    PeerConnectionFactory.builder()
                            .setAudioDeviceModule(adm)
                            .setVideoEncoderFactory(module.mVideoEncoderFactory)
                            .setVideoDecoderFactory(module.mVideoDecoderFactory)
                            .createPeerConnectionFactory();
            // The factory owns the device's native pointer now (as in WebRTCModule's constructor).
            adm.release();
            voiceAdm = adm;
        }
        module.mFactory = voiceFactory;
        module.mAudioDeviceModule = voiceAdm;
        return true;
    }

    /** New peer connections and tracks use the media device again. */
    public static synchronized void useMediaDevice(ReactApplicationContext context) {
        WebRTCModule module = context.getNativeModule(WebRTCModule.class);
        if (module == null || owner != module || mediaFactory == null) return;
        module.mFactory = mediaFactory;
        module.mAudioDeviceModule = mediaAdm;
    }
}
