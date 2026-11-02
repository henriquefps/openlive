// SPDX-License-Identifier: AGPL-3.0-only

// Command openlive-helper is the Openlive streaming helper.
//
// This first version has the synthetic test source only ("helper de teste", §20):
//
//	openlive-helper pair --instance https://openlive.example.com
//	openlive-helper test-stream --room <roomId> [--preset 1080p60] [--no-audio] [--layers f,h,q] [--encoder auto|nvh264|va|va-lp|x264]
//	openlive-helper test-stream --loopback        (no instance: publish to an in-process receiver)
//	openlive-helper stream --room <roomId> --source monitor|window [--audio-app <name>|window]
//	openlive-helper run [--encoder auto|nvh264|va|va-lp|x264] [--minimized]   (stay connected in the tray; the web starts and stops streams)
//	openlive-helper autostart enable|disable|status
//	openlive-helper status
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strings"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/store"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "0.1.0-dev"

func userAgent() string {
	return fmt.Sprintf("openlive-helper/%s (%s; %s)", version, runtime.GOOS, runtime.GOARCH)
}

const usage = `Usage: openlive-helper <command> [flags]

Commands:
  pair         Pair this device with an Openlive instance
  run          Stay connected (in the system tray) so the web can start, pause and stop streams
  autostart    Start "run" with the desktop session: enable, disable or status
  test-stream  Publish the synthetic test source to a room
  stream       Publish a monitor or a window (Linux: Wayland portal + PipeWire)
  status       Show the build, the encoders and the paired instances
  doctor       Print the system, GPU, GStreamer and encoder report for a bug report
  debug        Developer checks on the real desktop: "debug ping" draws a pointer ping
  version      Print the version

Run "openlive-helper <command> -h" for the flags of a command.
`

// errNotApp means the binary was started without a command outside the macOS app bundle.
var errNotApp = errors.New("not started from the app bundle")

func main() {
	// Finder starts the macOS app without arguments (older macOS added -psn_…): app.go.
	if len(os.Args) < 2 || strings.HasPrefix(os.Args[1], "-psn_") {
		err := startAsApp()
		if errors.Is(err, errNotApp) {
			fmt.Fprint(os.Stderr, usage)
			os.Exit(2)
		}
		if err != nil {
			os.Exit(1)
		}
		return
	}
	var err error
	switch cmd, args := os.Args[1], os.Args[2:]; cmd {
	case "pair":
		err = runPair(args)
	case "run":
		// On Linux "run" restarts itself after a crash (supervise.go); launchd does it on macOS.
		if runtime.GOOS == "linux" {
			if code, ok := superviseRun(os.Args, slog.New(slog.NewTextHandler(os.Stderr, nil))); ok {
				os.Exit(code)
			}
		}
		err = runHub(args)
	case "autostart":
		err = runAutostart(args, os.Stdout)
	case "test-stream":
		err = runTestStream(args)
	case "stream":
		err = runStream(args)
	case "status":
		err = runStatus(args, os.Stdout)
	case "doctor":
		err = runDoctor(args, os.Stdout)
	case "debug":
		err = runDebug(args, os.Stdout)
	case "version", "--version":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", explain(err))
		os.Exit(1)
	}
}

// common are the flags every command that touches the configuration takes.
type common struct {
	instance  string
	configDir string
	tokenFile bool
	verbose   bool
}

func (c *common) register(fs *flag.FlagSet) {
	fs.StringVar(&c.instance, "instance", "", "Openlive instance URL (default: the last paired one)")
	fs.StringVar(&c.configDir, "config-dir", "", "configuration directory (default: $OPENLIVE_HELPER_CONFIG_DIR or the user config dir)")
	fs.BoolVar(&c.tokenFile, "insecure-token-file", false, "store the device token in a 0600 file instead of the system keyring (CI and headless machines only)")
	fs.BoolVar(&c.verbose, "v", false, "verbose logs")
}

func (c *common) dir() (string, error) {
	if c.configDir != "" {
		return c.configDir, nil
	}
	return store.DefaultDir()
}

func (c *common) tokens() (store.TokenStore, error) {
	if !c.tokenFile {
		return store.Keyring{}, nil
	}
	dir, err := c.dir()
	if err != nil {
		return nil, err
	}
	return &store.File{Path: store.TokenFilePath(dir)}, nil
}

func (c *common) logger(w io.Writer) *slog.Logger {
	level := slog.LevelInfo
	if c.verbose {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: level}))
}

// paired loads the config and the token of the instance to use.
func (c *common) paired() (*api.Client, store.Instance, error) {
	dir, err := c.dir()
	if err != nil {
		return nil, store.Instance{}, err
	}
	cfg, err := store.LoadConfig(store.ConfigPath(dir))
	if err != nil {
		return nil, store.Instance{}, err
	}
	instance := c.instance
	if instance == "" {
		instance = cfg.DefaultInstance
	}
	if instance == "" {
		return nil, store.Instance{}, errors.New("not paired: run openlive-helper pair --instance https://<your instance>")
	}
	u, err := api.ParseInstance(instance)
	if err != nil {
		return nil, store.Instance{}, err
	}
	in, ok := cfg.Instances[u.String()]
	if !ok {
		return nil, store.Instance{}, fmt.Errorf("not paired with %s: run openlive-helper pair --instance %s", u, u)
	}
	tokens, err := c.tokens()
	if err != nil {
		return nil, store.Instance{}, err
	}
	tok, err := tokens.Get(u.String())
	if err != nil {
		return nil, store.Instance{}, fmt.Errorf("device token for %s (%s): %w", u, tokens.Name(), err)
	}
	client, err := api.NewClient(u.String(), tok, userAgent())
	return client, in, err
}
