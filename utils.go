package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxRetries = 3
	retryDelay = 1 * time.Second
)

func downloadFile(url, path string) error {
	for i := 0; i < maxRetries; i++ {
		err := func() error {
			resp, err := http.Get(url)
			if err != nil {
				return err
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("HTTP %s", resp.Status)
			}

			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				return err
			}

			out, err := os.Create(path)
			if err != nil {
				return err
			}
			defer out.Close()

			_, err = io.Copy(out, resp.Body)
			return err
		}()

		if err == nil {
			return nil
		}
		time.Sleep(time.Duration(i+1) * retryDelay)
	}
	return fmt.Errorf("download failed after %d attempts", maxRetries)
}

func promptIfEmpty(value *string, message string) {
	if *value != "" {
		return
	}
	fmt.Print(message)
	fmt.Scanln(value)
}

func exitErr(format string, args ...interface{}) {
	fmt.Printf(format+"\n", args...)
	os.Exit(1)
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func isModFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".jar" || ext == ".zip"
}
