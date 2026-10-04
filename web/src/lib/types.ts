export type Channel = "release" | "beta" | "alpha";

export const CHANNELS: readonly Channel[] = ["release", "beta", "alpha"];

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  projects: string[];
}

export interface Project {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string | null;
  color: number | null;
  project_type: string;
  game_versions: string[];
  loaders: string[];
}

export interface VersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  hashes: { sha1?: string; sha512?: string };
}

export interface Dependency {
  project_id: string | null;
  version_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
}

export interface Version {
  id: string;
  project_id: string;
  version_number: string;
  version_type: Channel | null;
  game_versions: string[];
  loaders: string[];
  files: VersionFile[];
  dependencies: Dependency[];
}

export interface GameVersionTag {
  version: string;
  version_type: "release" | "snapshot" | "alpha" | "beta";
  major: boolean;
}
