package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	baseURL   = "https://api.modrinth.com/v3"
	userAgent = "modrinth-dl/2.1"
)

type ModrinthClient struct {
	client *http.Client
}

type Collection struct {
	Projects []string `json:"projects"`
}

type Version struct {
	GameVersions []string `json:"game_versions"`
	Loaders      []string `json:"loaders"`
	Files        []File   `json:"files"`
}

type File struct {
	URL      string `json:"url"`
	Primary  bool   `json:"primary"`
	Filename string `json:"filename"`
}

type ModResult struct {
	ID     string
	Name   string
	Status string
}

type ModError struct {
	ID      string
	Name    string
	Message string
}

func NewModrinthClient() *ModrinthClient {
	return &ModrinthClient{
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *ModrinthClient) FetchCollection(collectionID string) *Collection {
	var collection Collection
	if err := c.fetchWithRetry("/collection/"+collectionID, &collection); err != nil {
		exitErr("Failed to fetch collection: %v", err)
	}
	return &collection
}

func processMod(client *ModrinthClient, cfg *Config, modID string, existingMods map[string]string) (ModResult, error) {
	var versions []Version
	if err := client.fetchWithRetry("/project/"+modID+"/version", &versions); err != nil {
		return ModResult{}, err
	}

	version := findCompatibleVersion(versions, cfg.mcVersion, cfg.loader)
	if version == nil {
		return ModResult{}, fmt.Errorf("no compatible version found")
	}

	file := selectFile(version.Files)
	filename := constructFilename(file.Filename, modID)
	targetPath := filepath.Join(cfg.directory, filename)

	if handleExisting(modID, filename, existingMods, cfg.directory, cfg.update) {
		return ModResult{
			ID:     modID,
			Name:   extractModName(file.Filename),
			Status: "exists",
		}, nil
	}

	if err := downloadFile(file.URL, targetPath); err != nil {
		return ModResult{}, err
	}

	return ModResult{
		ID:     modID,
		Name:   extractModName(file.Filename),
		Status: "downloaded",
	}, nil
}

func getExistingMods(dir string) map[string]string {
	mods := make(map[string]string)
	entries, _ := os.ReadDir(dir)

	for _, e := range entries {
		if e.IsDir() || !isModFile(e.Name()) {
			continue
		}
		parts := strings.Split(e.Name(), "@")
		if len(parts) >= 2 {
			modID := strings.Split(parts[len(parts)-1], ".")[0]
			mods[modID] = e.Name()
		}
	}
	return mods
}

func findCompatibleVersion(versions []Version, mcVersion, loader string) *Version {
	for _, v := range versions {
		if contains(v.GameVersions, mcVersion) && contains(v.Loaders, loader) {
			return &v
		}
	}
	return nil
}

func (c *ModrinthClient) fetchWithRetry(path string, v interface{}) error {
	var err error
	for i := 0; i < 3; i++ {
		if err = c.fetchJSON(path, v); err == nil {
			return nil
		}
		time.Sleep(time.Duration(i+1) * time.Second)
	}
	return fmt.Errorf("failed after 3 attempts: %w", err)
}

func (c *ModrinthClient) fetchJSON(path string, v interface{}) error {
	req, err := http.NewRequest("GET", baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API request failed: %s", resp.Status)
	}

	return json.NewDecoder(resp.Body).Decode(v)
}

func selectFile(files []File) File {
	for _, f := range files {
		if f.Primary {
			return f
		}
	}
	return files[0]
}

func constructFilename(original, modID string) string {
	ext := filepath.Ext(original)
	base := strings.TrimSuffix(original, ext)
	return fmt.Sprintf("%s@%s%s", base, modID, ext)
}

func extractModName(filename string) string {
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	parts := strings.Split(base, "-")
	if len(parts) > 1 {
		return strings.Join(parts[:len(parts)-1], " ")
	}
	return base
}

func handleExisting(modID, filename string, existingMods map[string]string, dir string, update bool) bool {
	existingFile, exists := existingMods[modID]
	if !exists {
		return false
	}

	if !update || existingFile == filename {
		return true
	}

	os.Remove(filepath.Join(dir, existingFile))
	return false
}
