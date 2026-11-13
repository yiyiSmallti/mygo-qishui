package main

import "testing"

func TestPreviousEnhanced124Upgrade(t *testing.T) {
	if !supportedHash("1d24335b1d82cf9027aac25c07d1b1c98b5fef273c28857f953079c8bff3939d") {
		t.Fatal("published 0.6.9 enhanced player must support upgrading")
	}
	if supportedHash("1d24335b1d82cf9027aac25c07d1b1c98b5fef273c28857f953079c8bff3939e") {
		t.Fatal("unverified player must remain unsupported")
	}
}

func TestEnhancementStatus(t *testing.T) {
	const payload = "new-payload"
	for _, tc := range []struct{ hash, want string }{
		{payload, "installed"},
		{officialHash, "not-installed"},
		{previousOfficialHash, "not-installed"},
		{previousEnhanced124Hash, "update-available"},
		{previousEnhanced0610Hash, "update-available"},
		{previousSettingsHash, "update-available"},
		{"unverified-build", "unsupported"},
	} {
		if got := enhancementStatus(tc.hash, payload); got != tc.want {
			t.Errorf("enhancementStatus(%q) = %q, want %q", tc.hash, got, tc.want)
		}
	}
}
