// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"time"

	"github.com/henriquefps/openlive/helper/internal/api"
	"github.com/henriquefps/openlive/helper/internal/store"
	protocol "github.com/henriquefps/openlive/packages/protocol/go"
)

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ContinueOnError)
	var c common
	c.register(fs)
	host, _ := os.Hostname()
	name := fs.String("name", host, "device name shown in Settings > Devices")
	noBrowser := fs.Bool("no-browser", false, "do not open the browser, only print the link")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if c.instance == "" {
		return fmt.Errorf("--instance is required (for example --instance https://openlive.example.com)")
	}
	client, err := api.NewClient(c.instance, "", userAgent())
	if err != nil {
		return err
	}
	instance := client.Base.String()
	if _, err := c.tokens(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	p := &api.Pairer{
		Client: client,
		Prompt: func(pp api.PairingPrompt) {
			fmt.Printf("Open %s and enter the code %s\n", pp.URL, pp.UserCode)
			fmt.Printf("The code expires at %s. Waiting for confirmation...\n", pp.ExpiresAt.Format(time.Kitchen))
		},
	}
	if !*noBrowser {
		p.OpenBrowser = openBrowser
	}
	req := protocol.DeviceCodeRequest{OS: osName(), Arch: protocol.DeviceArch(runtime.GOARCH), HelperVersion: version}
	if *name != "" {
		req.Name = name
	}
	tok, err := p.Pair(ctx, req)
	if err != nil {
		return err
	}
	// The person may rename the device on /link; the token answer does not say the final
	// name, so this is the suggested one.
	if err := storePairing(&c, instance, tok, *name, true); err != nil {
		return err
	}
	tokens, _ := c.tokens()
	fmt.Printf("Paired with %s as %q. The device token is in the %s.\n", instance, *name, tokens.Name())
	return nil
}

// storePairing keeps a new device token and records the instance; makeDefault also makes
// it the instance commands use without --instance.
func storePairing(c *common, instance string, tok protocol.DeviceTokenResponse, deviceName string, makeDefault bool) error {
	tokens, err := c.tokens()
	if err != nil {
		return err
	}
	dir, err := c.dir()
	if err != nil {
		return err
	}
	if err := tokens.Set(instance, tok.DeviceToken); err != nil {
		return fmt.Errorf("store the device token in the %s: %w (on a headless machine, pass --insecure-token-file)", tokens.Name(), err)
	}
	cfg, err := store.LoadConfig(store.ConfigPath(dir))
	if err != nil {
		return err
	}
	previous := cfg.DefaultInstance
	cfg.Remember(store.Instance{URL: instance, DeviceID: tok.DeviceID, DeviceName: deviceName, PairedAt: time.Now().UTC()})
	if !makeDefault && previous != "" {
		cfg.DefaultInstance = previous
	}
	return store.SaveConfig(store.ConfigPath(dir), cfg)
}

// osName is the DeviceCodeRequest.os value: linux, windows or macos.
func osName() protocol.DeviceOS {
	if runtime.GOOS == "darwin" {
		return protocol.DeviceOSMacos
	}
	return protocol.DeviceOS(runtime.GOOS)
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
