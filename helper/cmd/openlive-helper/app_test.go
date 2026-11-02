// SPDX-License-Identifier: AGPL-3.0-only

//go:build unix

package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestAppBundle(t *testing.T) {
	for exe, want := range map[string]string{
		"/Applications/Openlive Helper.app/Contents/MacOS/openlive-helper":          "/Applications/Openlive Helper.app",
		"/Users/me/Applications/Openlive Helper.app/Contents/MacOS/openlive-helper": "/Users/me/Applications/Openlive Helper.app",
		"/usr/local/bin/openlive-helper":                                            "",
		"/x/Contents/MacOS/openlive-helper":                                         "",
		"/x/Foo.app/Contents/Helpers/openlive-helper":                               "",
	} {
		got, ok := appBundle(exe)
		if got != want || ok != (want != "") {
			t.Errorf("appBundle(%q) = %q %v, want %q", exe, got, ok, want)
		}
	}
}

func TestRunFromDiskImage(t *testing.T) {
	for app, want := range map[string]bool{
		"/Volumes/Openlive Helper/Openlive Helper.app":                         true,
		"/private/var/folders/x/T/AppTranslocation/0A1B/d/Openlive Helper.app": true,
		"/Applications/Openlive Helper.app":                                    false,
		"/Users/me/Applications/Openlive Helper.app":                           false,
	} {
		if got := runFromDiskImage(app); got != want {
			t.Errorf("runFromDiskImage(%q) = %v", app, got)
		}
	}
}

func TestAppLocale(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	apple := func(s string) func() string { return func() string { return s } }
	if got := appLocale(env(map[string]string{"LANG": "en_GB.UTF-8"}), apple("pt_BR")); got != "en_GB.UTF-8" {
		t.Errorf("LANG wins: %q", got)
	}
	if got := appLocale(env(nil), apple("pt_BR\n")); got != "pt_BR.UTF-8" {
		t.Errorf("AppleLocale: %q", got)
	}
	if got := appLocale(env(nil), apple("en_US@rg=brzzzz")); got != "en_US.UTF-8" {
		t.Errorf("region suffix: %q", got)
	}
	if got := appLocale(env(nil), apple("")); got != "" {
		t.Errorf("nothing: %q", got)
	}
}

func TestAppDialog(t *testing.T) {
	s := appDialog(`Openlive "Helper"`, `C:\ path`, true)
	for _, want := range []string{`display dialog "C:\\ path"`, `with title "Openlive \"Helper\""`, `buttons {"OK"}`, "with icon caution"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
}

func TestLaunchctlSteps(t *testing.T) {
	first, fallback := launchctlSteps(501, "/p.plist", true)
	if !reflect.DeepEqual(first, [][]string{{"bootout", "gui/501/dev.hfps.OpenliveHelper"}, {"bootstrap", "gui/501", "/p.plist"}}) || fallback != nil {
		t.Errorf("changed: %v %v", first, fallback)
	}
	first, fallback = launchctlSteps(501, "/p.plist", false)
	if !reflect.DeepEqual(first, [][]string{{"kickstart", "gui/501/dev.hfps.OpenliveHelper"}}) ||
		!reflect.DeepEqual(fallback, []string{"bootstrap", "gui/501", "/p.plist"}) {
		t.Errorf("unchanged: %v %v", first, fallback)
	}
}
