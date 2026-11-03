// SPDX-License-Identifier: AGPL-3.0-only

// Package i18n holds the helper's desktop strings (tray menu, notifications, shortcut
// descriptions): English by default, pt-BR when the system locale asks for it. Log lines and CLI errors stay in English.
package i18n

import (
	"fmt"
	"os"
	"strings"
)

// Lang is a supported language.
type Lang string

const (
	En   Lang = "en"
	PtBR Lang = "pt-BR"
)

// Key names one string.
type Key string

const (
	StatusIdle         Key = "status.idle"
	StatusOffline      Key = "status.offline"
	StatusStarting     Key = "status.starting"
	StatusLive         Key = "status.live"
	StatusPaused       Key = "status.paused"
	StatusCurtain      Key = "status.curtain"
	StatusStopping     Key = "status.stopping"
	StatusError        Key = "status.error"
	StatusInstance     Key = "status.instance"
	StatusRoom         Key = "status.room"
	StatusPreset       Key = "status.preset"
	StatusViewers      Key = "status.viewers"
	MenuPause          Key = "menu.pause"
	MenuResume         Key = "menu.resume"
	MenuCurtainOn      Key = "menu.curtain_on"
	MenuCurtainOff     Key = "menu.curtain_off"
	MenuStop           Key = "menu.stop"
	MenuOpen           Key = "menu.open"
	MenuPair           Key = "menu.pair"
	MenuQuit           Key = "menu.quit"
	ShortcutCurtain    Key = "shortcut.curtain"
	ShortcutPause      Key = "shortcut.pause"
	ShortcutStop       Key = "shortcut.stop"
	ShortcutTalk       Key = "shortcut.talk"
	ShortcutMute       Key = "shortcut.mute"
	ShortcutDeafen     Key = "shortcut.deafen"
	ShortcutConflict   Key = "shortcut.conflict"
	NotifyStarted      Key = "notify.started"
	NotifyStartedBody  Key = "notify.started_body"
	NotifyStopped      Key = "notify.stopped"
	NotifyStoppedBody  Key = "notify.stopped_body"
	NotifyDropped      Key = "notify.dropped"
	NotifyUnstable     Key = "notify.unstable"
	NotifyUnstableBody Key = "notify.unstable_body"
	NotifyViewer       Key = "notify.viewer"
	NotifyViewerBody   Key = "notify.viewer_body"
	NotifyCurtainOn    Key = "notify.curtain_on"
	NotifyCurtainOff   Key = "notify.curtain_off"
	NotifyReady        Key = "notify.ready"
	NotifyReadyBody    Key = "notify.ready_body"
	PairTitle          Key = "pair.title"
	PairPrompt         Key = "pair.prompt"
	PairCode           Key = "pair.code"
	PairDone           Key = "pair.done"
	PairFailed         Key = "pair.failed"
	PairManual         Key = "pair.manual"
	AppTitle           Key = "app.title"
	AppMove            Key = "app.move"
	AppPairPrompt      Key = "app.pair_prompt"
	AppReady           Key = "app.ready"
	AppFailed          Key = "app.failed"
	TooltipTitle       Key = "tooltip.title"
	VoiceSinkLabel     Key = "voice_sink.label"
)

var catalog = map[Lang]map[Key]string{
	En: {
		StatusIdle:         "Ready, not streaming",
		StatusOffline:      "Connecting to %s…",
		StatusStarting:     "Starting the stream…",
		StatusLive:         "Live",
		StatusPaused:       "Paused",
		StatusCurtain:      "Privacy curtain on",
		StatusStopping:     "Stopping…",
		StatusError:        "The last stream failed",
		StatusInstance:     "Instance: %s",
		StatusRoom:         "Room: %s",
		StatusPreset:       "Preset: %s",
		StatusViewers:      "Viewers: %d",
		MenuPause:          "Pause",
		MenuResume:         "Resume",
		MenuCurtainOn:      "Privacy curtain",
		MenuCurtainOff:     "Lift the privacy curtain",
		MenuStop:           "Stop stream",
		MenuOpen:           "Open Openlive",
		MenuPair:           "Pair another instance…",
		MenuQuit:           "Quit",
		ShortcutCurtain:    "Openlive: privacy curtain on/off",
		ShortcutPause:      "Openlive: pause/resume the stream",
		ShortcutStop:       "Openlive: stop the stream",
		ShortcutTalk:       "Openlive: push-to-talk in voice (hold)",
		ShortcutMute:       "Openlive: mute/unmute the microphone in voice",
		ShortcutDeafen:     "Openlive: deafen/undeafen in voice",
		ShortcutConflict:   "The shortcut %s is used by another app: pick another one in the helper's config file",
		NotifyStarted:      "You are live",
		NotifyStartedBody:  "Streaming %s to %s.",
		NotifyStopped:      "Stream stopped",
		NotifyStoppedBody:  "You are no longer streaming.",
		NotifyDropped:      "Your stream dropped",
		NotifyUnstable:     "Network unstable",
		NotifyUnstableBody: "Quality reduced to keep the stream going.",
		NotifyViewer:       "Someone started watching",
		NotifyViewerBody:   "%d watching now.",
		NotifyCurtainOn:    "Privacy curtain on: viewers see \"Paused\".",
		NotifyCurtainOff:   "Privacy curtain lifted: viewers see your screen again.",
		NotifyReady:        "Openlive helper is running",
		NotifyReadyBody:    "Go live from Openlive in your browser. The helper stays in the system tray.",
		PairTitle:          "Pair with an Openlive instance",
		PairPrompt:         "Instance address (for example https://openlive.example.com):",
		PairCode:           "Enter the code %s on %s",
		PairDone:           "Paired with %s",
		PairFailed:         "Pairing failed: %s",
		PairManual:         "Run in a terminal: openlive-helper pair --instance https://<your instance>",
		AppTitle:           "Openlive Helper",
		AppMove:            "Drag Openlive Helper into the Applications folder, then open it from there.",
		AppPairPrompt:      "Openlive Helper streams your screen to your Openlive instance. Enter its address (for example https://openlive.example.com); the browser then asks you to confirm.",
		AppReady:           "Openlive Helper is in the menu bar and starts when you log in. If macOS asks, allow Screen Recording. Then use Go live in a room on %s.",
		AppFailed:          "Openlive Helper could not start: %s",
		TooltipTitle:       "Openlive helper",
		VoiceSinkLabel:     "Openlive – voice",
	},
	PtBR: {
		StatusIdle:         "Pronto, sem transmitir",
		StatusOffline:      "Conectando a %s…",
		StatusStarting:     "Iniciando a transmissão…",
		StatusLive:         "Ao vivo",
		StatusPaused:       "Pausado",
		StatusCurtain:      "Cortina de privacidade ligada",
		StatusStopping:     "Parando…",
		StatusError:        "A última transmissão falhou",
		StatusInstance:     "Instância: %s",
		StatusRoom:         "Sala: %s",
		StatusPreset:       "Preset: %s",
		StatusViewers:      "Assistindo: %d",
		MenuPause:          "Pausar",
		MenuResume:         "Retomar",
		MenuCurtainOn:      "Cortina de privacidade",
		MenuCurtainOff:     "Tirar a cortina de privacidade",
		MenuStop:           "Parar a transmissão",
		MenuOpen:           "Abrir o Openlive",
		MenuPair:           "Parear outra instância…",
		MenuQuit:           "Sair",
		ShortcutCurtain:    "Openlive: ligar/desligar a cortina de privacidade",
		ShortcutPause:      "Openlive: pausar/retomar a transmissão",
		ShortcutStop:       "Openlive: parar a transmissão",
		ShortcutTalk:       "Openlive: aperte para falar na voz (segure)",
		ShortcutMute:       "Openlive: silenciar/reativar o microfone na voz",
		ShortcutDeafen:     "Openlive: ensurdecer/voltar a ouvir na voz",
		ShortcutConflict:   "O atalho %s já é usado por outro app: escolha outro no arquivo de configuração do helper",
		NotifyStarted:      "Você está ao vivo",
		NotifyStartedBody:  "Transmitindo %s em %s.",
		NotifyStopped:      "Transmissão encerrada",
		NotifyStoppedBody:  "Você não está mais transmitindo.",
		NotifyDropped:      "Sua transmissão caiu",
		NotifyUnstable:     "Rede instável",
		NotifyUnstableBody: "Qualidade reduzida para manter a transmissão.",
		NotifyViewer:       "Alguém começou a assistir",
		NotifyViewerBody:   "%d assistindo agora.",
		NotifyCurtainOn:    "Cortina de privacidade ligada: quem assiste vê \"Pausado\".",
		NotifyCurtainOff:   "Cortina de privacidade desligada: quem assiste vê sua tela de novo.",
		NotifyReady:        "O helper do Openlive está rodando",
		NotifyReadyBody:    "Comece a transmitir pelo Openlive no navegador. O helper fica na bandeja do sistema.",
		PairTitle:          "Parear com uma instância do Openlive",
		PairPrompt:         "Endereço da instância (por exemplo https://openlive.example.com):",
		PairCode:           "Digite o código %s em %s",
		PairDone:           "Pareado com %s",
		PairFailed:         "O pareamento falhou: %s",
		PairManual:         "Rode num terminal: openlive-helper pair --instance https://<sua instância>",
		AppTitle:           "Openlive Helper",
		AppMove:            "Arraste o Openlive Helper para a pasta Aplicativos e abra-o de lá.",
		AppPairPrompt:      "O Openlive Helper transmite sua tela para a sua instância do Openlive. Digite o endereço dela (por exemplo https://openlive.example.com); o navegador pede então a confirmação.",
		AppReady:           "O Openlive Helper está na barra de menus e abre quando você entra na sessão. Se o macOS pedir, permita a Gravação de Tela. Depois use Transmitir numa sala em %s.",
		AppFailed:          "O Openlive Helper não conseguiu abrir: %s",
		TooltipTitle:       "Helper do Openlive",
		VoiceSinkLabel:     "Openlive – voz",
	},
}

// Catalog translates keys into one language; English fills any missing key.
type Catalog struct{ Lang Lang }

// T is the string for key, formatted with args.
func (c Catalog) T(key Key, args ...any) string {
	s, ok := catalog[c.Lang][key]
	if !ok {
		s, ok = catalog[En][key]
	}
	if !ok {
		s = string(key)
	}
	if len(args) == 0 {
		return s
	}
	return fmt.Sprintf(s, args...)
}

// Parse maps a setting or a POSIX locale ("pt_BR.UTF-8", "pt-BR", "en_US") to a
// supported language; ok is false for anything else.
func Parse(s string) (Lang, bool) {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, ".@"); i >= 0 {
		s = s[:i]
	}
	s = strings.ToLower(strings.ReplaceAll(s, "_", "-"))
	switch {
	case s == "pt" || strings.HasPrefix(s, "pt-"):
		// pt_PT reads pt-BR better than English.
		return PtBR, true
	case s == "en" || strings.HasPrefix(s, "en-"):
		return En, true
	}
	return "", false
}

// Detect picks the language: the setting when it names one, else the system locale
// (LANGUAGE's first entry, LC_ALL, LC_MESSAGES, LANG), else English.
func Detect(setting string, getenv func(string) string) Lang {
	if getenv == nil {
		getenv = os.Getenv
	}
	if l, ok := Parse(setting); ok {
		return l
	}
	if first, _, _ := strings.Cut(getenv("LANGUAGE"), ":"); first != "" {
		if l, ok := Parse(first); ok {
			return l
		}
	}
	for _, v := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if s := getenv(v); s != "" {
			if l, ok := Parse(s); ok {
				return l
			}
			// The first locale variable set wins, even an unsupported one.
			return En
		}
	}
	return En
}
