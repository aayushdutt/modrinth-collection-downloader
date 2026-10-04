import { Ground } from "./Sky";

const REPO = "https://github.com/aayushdutt/modrinth-collection-downloader";

const LINKS = [
  { href: REPO, label: "Source on GitHub" },
  { href: `${REPO}#-quick-start`, label: "Command-line version" },
  { href: "https://github.com/aayushdutt/mctui", label: "mctui launcher" },
];

export function Footer() {
  return (
    <Ground>
      <p className="font-pixel text-[16px]">
        {LINKS.map((link, i) => (
          <span key={link.href}>
            {i > 0 && <span className="mx-3 text-white/60">/</span>}
            <a className="underline underline-offset-4 hover:text-mc-yellow" href={link.href}>
              {link.label}
            </a>
          </span>
        ))}
      </p>
      <p className="mt-3 max-w-[60ch] text-[14px] text-white/85">
        Runs in your browser and downloads straight from Modrinth. Not an official Minecraft product. Not approved by or
        associated with Mojang or Microsoft.
      </p>
    </Ground>
  );
}
