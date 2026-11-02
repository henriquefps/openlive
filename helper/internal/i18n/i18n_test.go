// SPDX-License-Identifier: AGPL-3.0-only

package i18n

import (
	"strings"
	"testing"
)

func TestCatalogsHaveTheSameKeys(t *testing.T) {
	for key, en := range catalog[En] {
		pt, ok := catalog[PtBR][key]
		if !ok {
			t.Errorf("pt-BR misses %s", key)
			continue
		}
		if strings.Count(en, "%") != strings.Count(pt, "%") {
			t.Errorf("%s: en %q and pt-BR %q take different arguments", key, en, pt)
		}
	}
	for key := range catalog[PtBR] {
		if _, ok := catalog[En][key]; !ok {
			t.Errorf("en misses %s", key)
		}
	}
}

func TestDetect(t *testing.T) {
	cases := []struct {
		setting string
		env     map[string]string
		want    Lang
	}{
		{"", map[string]string{"LANG": "pt_BR.UTF-8"}, PtBR},
		{"", map[string]string{"LANG": "en_US.UTF-8"}, En},
		{"", map[string]string{"LC_ALL": "C", "LANG": "pt_BR.UTF-8"}, En},
		{"", map[string]string{"LC_MESSAGES": "pt_PT@euro"}, PtBR},
		{"", map[string]string{"LANGUAGE": "pt_BR:en", "LANG": "en_US.UTF-8"}, PtBR},
		{"", map[string]string{"LANG": "de_DE.UTF-8"}, En},
		{"", nil, En},
		{"en", map[string]string{"LANG": "pt_BR.UTF-8"}, En},
		{"pt-BR", map[string]string{"LANG": "en_US.UTF-8"}, PtBR},
		{"klingon", map[string]string{"LANG": "pt_BR.UTF-8"}, PtBR},
	}
	for _, c := range cases {
		got := Detect(c.setting, func(k string) string { return c.env[k] })
		if got != c.want {
			t.Errorf("Detect(%q, %v) = %s, want %s", c.setting, c.env, got, c.want)
		}
	}
}

func TestT(t *testing.T) {
	pt := Catalog{Lang: PtBR}
	if got := pt.T(StatusViewers, 3); got != "Assistindo: 3" {
		t.Errorf("pt-BR viewers = %q", got)
	}
	if got := (Catalog{Lang: "xx"}).T(MenuQuit); got != "Quit" {
		t.Errorf("fallback = %q", got)
	}
	if got := pt.T("no.such.key"); got != "no.such.key" {
		t.Errorf("unknown key = %q", got)
	}
}
