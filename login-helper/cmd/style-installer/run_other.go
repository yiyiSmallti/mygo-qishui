//go:build !windows

package main

import "errors"

func run(uint32, func(string) error) error { return errors.New("unsupported") }
