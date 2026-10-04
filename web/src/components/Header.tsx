import { Splash } from "./Splash";

export function Header() {
  return (
    <header className="mb-8">
      <div className="relative">
        <h1 className="font-pixel text-[38px] leading-[0.95] font-semibold text-white text-mc-shadow sm:text-[54px]">
          Modrinth Collection Downloader
        </h1>
        <Splash />
      </div>
      <p className="mt-5 max-w-[38ch] text-[17px] leading-relaxed text-white [text-shadow:0_1px_2px_rgb(0_0_0/.45)]">
        Download a whole Modrinth collection, dependencies included, in one go.
      </p>
    </header>
  );
}
