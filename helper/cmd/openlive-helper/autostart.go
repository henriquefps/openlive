// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/autostart"
	"github.com/henriquefps/openlive/helper/internal/store"
)

const autostartUsage = `Usage: openlive-helper autostart enable|disable|status [flags]

  enable   start "openlive-helper run --instance <paired> --minimized" with the desktop session
  disable  stop starting with the session
  status   say whether it is on and what it runs
`

// runAutostart writes or removes the XDG autostart entry (off by default).
func runAutostart(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(os.Stderr, autostartUsage)
		return flag.ErrHelp
	}
	sub, args := args[0], args[1:]
	fs := flag.NewFlagSet("autostart "+sub, flag.ContinueOnError)
	var c common
	c.register(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	dir, err := autostart.Dir()
	if err != nil {
		return err
	}
	switch sub {
	case "enable":
		entry, err := autostartEntry(&c)
		if err != nil {
			return err
		}
		path, err := autostart.Enable(dir, entry)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(out, "The helper starts with your session: %s\n", path)
	case "disable":
		removed, err := autostart.Disable(dir)
		if err != nil {
			return err
		}
		if removed {
			_, _ = fmt.Fprintln(out, "The helper no longer starts with your session.")
		} else {
			_, _ = fmt.Fprintln(out, "Autostart was already off.")
		}
	case "status":
		exec, on, err := autostart.Read(dir)
		if err != nil {
			return err
		}
		if !on {
			_, _ = fmt.Fprintln(out, "Autostart is off.")
		} else {
			_, _ = fmt.Fprintf(out, "Autostart is on: %s\n", exec)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown autostart command %q\n\n%s", sub, autostartUsage)
		return flag.ErrHelp
	}
	return nil
}

// autostartEntry runs this binary with the paired instance (the default one unless
// --instance says otherwise) and the config flags this command got.
func autostartEntry(c *common) (autostart.Entry, error) {
	dir, err := c.dir()
	if err != nil {
		return autostart.Entry{}, err
	}
	cfg, err := store.LoadConfig(store.ConfigPath(dir))
	if err != nil {
		return autostart.Entry{}, err
	}
	instance := c.instance
	if instance == "" {
		instance = cfg.DefaultInstance
	}
	if instance == "" {
		return autostart.Entry{}, errors.New("not paired: run openlive-helper pair --instance https://<your instance> first")
	}
	u, err := api.ParseInstance(instance)
	if err != nil {
		return autostart.Entry{}, err
	}
	if _, ok := cfg.Instances[u.String()]; !ok {
		return autostart.Entry{}, fmt.Errorf("not paired with %s: run openlive-helper pair --instance %s first", u, u)
	}
	bin, err := os.Executable()
	if err != nil {
		return autostart.Entry{}, err
	}
	if resolved, err := filepath.EvalSymlinks(bin); err == nil {
		bin = resolved
	}
	args := []string{"run", "--instance", u.String(), "--minimized"}
	if c.configDir != "" {
		abs, err := filepath.Abs(c.configDir)
		if err != nil {
			return autostart.Entry{}, err
		}
		args = append(args, "--config-dir", abs)
	}
	if c.tokenFile {
		args = append(args, "--insecure-token-file")
	}
	return autostart.Entry{
		Binary:  bin,
		Args:    args,
		Name:    "Openlive helper",
		Comment: "Stream to Openlive from the system tray",
	}, nil
}
