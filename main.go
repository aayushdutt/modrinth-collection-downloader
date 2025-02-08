package main

import (
	"flag"
	"fmt"
	"strings"
	"sync"
	"time"
)

type Config struct {
	collectionID string
	mcVersion    string
	loader       string
	directory    string
	update       bool
	workers      int
}

func main() {
	cfg := &Config{}
	cfg.parseFlags()
	cfg.promptMissing()

	client := NewModrinthClient()
	collection := client.FetchCollection(cfg.collectionID)
	existingMods := getExistingMods(cfg.directory)

	var (
		results    = make(map[string]ModResult)
		errors     = make(map[string]ModError)
		mu         sync.Mutex
		wg         sync.WaitGroup
		modChan    = make(chan string, len(collection.Projects))
		statusChan = make(chan string, len(collection.Projects))
	)

	go realtimeLogger(statusChan, len(collection.Projects))

	for i := 0; i < cfg.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for modID := range modChan {
				result, err := processMod(client, cfg, modID, existingMods)

				mu.Lock()
				if err != nil {
					errors[modID] = ModError{
						ID:      modID,
						Name:    extractModNameFromError(err, modID),
						Message: cleanErrorMessage(err),
					}
					statusChan <- fmt.Sprintf("❌ %s: %s", errors[modID].Name, errors[modID].Message)
				} else {
					results[modID] = result
					statusChan <- fmt.Sprintf("✅ %s: %s", result.Name, result.Status)
				}
				mu.Unlock()
			}
		}()
	}

	for _, modID := range collection.Projects {
		modChan <- modID
	}
	close(modChan)
	wg.Wait()
	close(statusChan)

	printSummary(collection.Projects, results, errors)
}

func (cfg *Config) parseFlags() {
	flag.StringVar(&cfg.collectionID, "c", "", "Collection ID")
	flag.StringVar(&cfg.mcVersion, "v", "", "Minecraft version")
	flag.StringVar(&cfg.loader, "l", "", "Mod loader (fabric/forge)")
	flag.StringVar(&cfg.directory, "d", "./mods", "Download directory")
	flag.BoolVar(&cfg.update, "u", false, "Update existing mods")
	flag.IntVar(&cfg.workers, "w", 5, "Parallel workers")
	flag.Parse()
}

func (cfg *Config) promptMissing() {
	promptIfEmpty(&cfg.collectionID, "Enter Collection ID: ")
	promptIfEmpty(&cfg.mcVersion, "Enter Minecraft version: ")
	promptIfEmpty(&cfg.loader, "Enter Mod loader: ")
}

func realtimeLogger(statusChan <-chan string, total int) {
	var processed int
	start := time.Now()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	spinner := []rune(`-\|/`)
	spinIdx := 0

	for {
		select {
		case status, ok := <-statusChan:
			if !ok {
				fmt.Printf("\r✅ Processed %d mods in %v\n", processed, time.Since(start).Round(time.Second))
				return
			}
			fmt.Printf("\r%s\n", status)
			processed++
		case <-ticker.C:
			spinIdx = (spinIdx + 1) % 4
			fmt.Printf("\r%c Processing %d/%d...", spinner[spinIdx], processed, total)
		}
	}
}

func printSummary(order []string, results map[string]ModResult, errors map[string]ModError) {
	fmt.Printf("\n=== Summary ===\n")
	fmt.Printf("Total mods:    %d\n", len(order))
	fmt.Printf("Successful:    %d\n", len(results))
	fmt.Printf("Errors:        %d\n\n", len(errors))

	fmt.Println("Processing Order:")
	for _, modID := range order {
		if result, exists := results[modID]; exists {
			statusSymbol := "✅"
			if result.Status == "exists" {
				statusSymbol = "ℹ️"
			}
			fmt.Printf("%s %-40s %s\n", statusSymbol, result.Name, result.Status)
		}
		if err, exists := errors[modID]; exists {
			fmt.Printf("❌ %-40s %s\n", err.Name, err.Message)
		}
	}

	if len(errors) > 0 {
		fmt.Println("\nError Details:")
		for _, err := range errors {
			fmt.Printf("❌ %-40s (%s)\n   %s\n", err.Name, err.ID, err.Message)
		}
	}
}

func extractModNameFromError(err error, modID string) string {
	if strings.Contains(err.Error(), "no compatible version found") {
		return modID
	}
	return "Unknown Mod"
}

func cleanErrorMessage(err error) string {
	msg := err.Error()
	if strings.HasPrefix(msg, "no compatible version found") {
		return "No compatible version available"
	}
	return msg
}
